import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  harness,
  cwd,
  readJson,
  atomicJson,
  until,
  orca,
  delay,
} from "./tui-test-utils.mjs";
const h = await harness("controls"),
  report = { checks: [], runs: [] };
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
  atomicJson(path.join(h.root, "result.json"), report);
};
const task =
  "Create a short todo plan. Ask contact_supervisor whether you may read README.md, and wait for the answer. After approval read README.md, finish the todo and report the sentence. Do not start other agents.";
async function start(workflow = false) {
  const r = await h.request({
    action: "start",
    execution: "orca-tui",
    coordination: "orca",
    viewMode: "orca",
    launch: workflow
      ? {
          cwd,
          workflowScript: `return runs.run("stop-test",{agent:"scout",context:"fresh",task:${JSON.stringify(task)}});`,
        }
      : { cwd, agent: "scout", context: "fresh", task },
  });
  const run = {
    runId: r.details.runId,
    asyncDir: r.details.asyncDir,
    coordinationRoot: r.details.coordination.root,
  };
  report.runs.push(run);
  await until(async () => {
    await h.request({ action: "sync_views", runId: run.runId });
    const pending = (await h.request({ action: "supervisor_pending" })).details
      .pending;
    return pending.length ? pending : undefined;
  }, "pending test question");
  return run;
}
try {
  const interrupted = await start();
  const link = readJson(path.join(interrupted.asyncDir, "tui", "child-0.json")),
    host = readJson(link.manifest);
  await orca([
    "terminal",
    "send",
    "--terminal",
    host.view.handle,
    "--text",
    "\u001b",
  ]);
  const pause = await until(() => {
    const s = readJson(path.join(interrupted.asyncDir, "status.json"));
    return s?.state !== "running" ? s : undefined;
  }, "direct TUI interruption");
  assert(
    pause.steps[0].interrupted || pause.state === "paused",
    JSON.stringify(pause),
  );
  pass("Escape in the actual Pi TUI propagates native interruption");
  const same = readJson(link.manifest);
  assert.equal(same.sessionId, host.sessionId);
  await orca([
    "terminal",
    "send",
    "--terminal",
    host.view.handle,
    "--text",
    "/new",
    "--enter",
  ]);
  await delay(500);
  assert.equal(readJson(link.manifest).sessionId, host.sessionId);
  pass("Managed /new cannot replace the assigned child session");
  const stopped = await start(true);
  const map = readJson(path.join(stopped.coordinationRoot, "mapping.json"));
  await until(
    () =>
      Object.keys(
        readJson(path.join(stopped.coordinationRoot, "health.json"))
          ?.questions || {},
      ).length > 0,
    "actual Orca question notification",
    30000,
  );
  pass("Orca receives the pending native question before its answer");
  const marker = path.join(stopped.coordinationRoot, "connection-pause");
  fs.writeFileSync(marker, "test-owned transport outage");
  await until(
    () =>
      readJson(path.join(stopped.coordinationRoot, "health.json"))
        ?.connected === false,
    "disconnection report",
    15000,
  );
  await h.request({ action: "stop", runId: stopped.runId });
  const failed = await until(() => {
    const s = readJson(path.join(stopped.asyncDir, "status.json"));
    return ["failed", "partial", "stopped", "complete"].includes(s?.state)
      ? s
      : undefined;
  }, "native stop");
  assert.notEqual(failed.state, "complete");
  pass("Native workflow Stop settles while Orca transport is unavailable");
  assert(!readJson(path.join(stopped.coordinationRoot, "health.json")).done);
  fs.unlinkSync(marker);
  const done = await until(
    () => readJson(path.join(stopped.coordinationRoot, "health.json"))?.done,
    "outbox recovery",
    30000,
  );
  assert.equal(done.outcome, "failed");
  pass(
    "Reconnection delivers failure to the original dispatch without a new start",
  );
  const dispatch = await orca([
    "orchestration",
    "dispatch-show",
    "--task",
    map.taskId,
  ]);
  report.dispatch = dispatch;
  const tasks = await orca([
    "orchestration",
    "task-list",
    "--run",
    map.orcaRunId,
  ]);
  report.tasks = tasks;
  pass("Orca dispatch-show and task-list verify the owned workflow");
} catch (error) {
  report.error = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  atomicJson(path.join(h.root, "result.json"), report);
  h.close();
  console.log("Control report:", h.root);
}
