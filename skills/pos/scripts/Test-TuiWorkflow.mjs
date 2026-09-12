import path from "node:path";
import fs from "node:fs";
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
let h = await harness("workflow");
const report = { root: h.root, checks: [] };
const reportFile = path.join(h.root, "result.json");
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
  atomicJson(reportFile, report);
};
try {
  const task =
    "Use todo to plan one short read. Ask contact_supervisor whether you may read README.md, and wait. After approval read README.md, finish the todo and report its exact sentence. Do not start other agents.";
  const script = `const options={agent:"scout",context:"fresh",task:${JSON.stringify(task)}}; const first=await Promise.all([runs.run("alpha",options),runs.run("beta",options)]); const last=await runs.run("dynamic",{agent:"scout",context:"fresh",task:"Use todo for one short read, read README.md, mark the todo complete and report its exact sentence. Do not start other agents."}); return {first,last};`;
  const start = await h.request({
    action: "start",
    execution: "orca-tui",
    ...(process.env.PI_BOTS_SHARED_DISPATCH === "1" ? {dispatchView:"shared"} : {}),
    coordination: "orca",
    viewMode: "orca",
    launch: { workflowScript: script, cwd },
  });
  const run = {
    runId: start.details.runId,
    asyncDir: start.details.asyncDir,
    coordinationRoot: start.details.coordination.root,
  };
  report.run = run;
  atomicJson(reportFile, report);
  const first = await until(
    async () => {
      await h.request({ action: "sync_views", runId: run.runId });
      const s = readJson(path.join(run.asyncDir, "status.json"));
      if (s?.state === "failed") throw Error(JSON.stringify(s));
      const children = [0, 1]
        .map((i) => readJson(path.join(run.asyncDir, "tui", `child-${i}.json`)))
        .filter(Boolean)
        .map((link) => readJson(link.manifest));
      return children.length === 2 &&
        children.every((c) => c?.state === "running")
        ? children
        : undefined;
    },
    "two native Pi TUIs",
    180000,
  );
  assert.notEqual(first[0].sessionId, first[1].sessionId);
  pass("Two parallel native children each own one real Pi TUI");
  for (const child of first)
    assert.equal(
      (await orca(["terminal", "show", "--terminal", child.view.handle]))
        .terminal.agentIdentity,
      "pi",
    );
  pass("Each workflow child is independently recognized as Pi");
  const pending = await until(async () => {
    const p = (await h.request({ action: "supervisor_pending" })).details
      .pending;
    return p.length === 2 ? p : undefined;
  }, "two supervisor questions");
  const initialMap = readJson(path.join(run.coordinationRoot, "mapping.json"));
  if (initialMap.tuiViewPolicy === "dispatch-first") {
    assert.equal(first.filter(child => child.view.handle === initialMap.worker.terminal.handle).length, 1);
    pass("Parallel children claim the shared dispatch pane exactly once");
    const hello = readJson(path.join(initialMap.worker.dir, "hello.json"));
    const pid = hello.pid;
    process.kill(pid);
    await delay(400);
    await h.request({ action: "sync_views", runId: run.runId });
    await until(()=>readJson(path.join(initialMap.worker.dir,"hello.json"))?.pid !== pid,"shared adapter restoration");
    for (const child of first) {
      const chat = fs.readFileSync(child.sessionFile,"utf8");
      assert(!chat.includes("orca-adapter.mjs"));
    }
    pass("Shared adapter recovery preserves both Pi sessions without shell input into their chats");
  }
  const ready = readJson(path.join(h.root, "ready.json"));
  h.close();
  await delay(500);
  h = await harness("workflow-reload", { sessionFile: ready.sessionFile });
  const restored = await h.request({ action: "status", runId: run.runId });
  assert(restored.details.views);
  pass(
    "Parent restart preserves the live workflow controller and child sessions",
  );
  for (const question of pending)
    await h.request({
      action: "supervisor_reply",
      replyTo: question.id,
      message: "Approved: read README.md and finish.",
    });
  const status = await until(
    async () => {
      const s = readJson(path.join(run.asyncDir, "status.json"));
      await h.request({ action: "sync_views", runId: run.runId });
      return ["complete", "failed", "partial", "stopped"].includes(s?.state)
        ? s
        : undefined;
    },
    "dynamic workflow completion",
    180000,
  );
  assert.equal(status.state, "complete", status.error);
  assert.equal(status.steps.length, 3);
  pass("Dynamic third child joins the same successful workflow");
  const hosts = status.steps.map((_, i) =>
    readJson(
      readJson(path.join(run.asyncDir, "tui", `child-${i}.json`)).manifest,
    ),
  );
  assert.equal(new Set(hosts.map((host) => host.sessionId)).size, 3);
  if (initialMap.tuiViewPolicy === "dispatch-first") {
    assert.equal(hosts.filter(host=>host.view.handle===initialMap.worker.terminal.handle).length,1);
    const ownHandles = new Set([initialMap.coordinator.terminal.handle,...hosts.map(host=>host.view.handle)]);
    assert.equal(ownHandles.size,4);
    pass("Three parallel/dynamic children use four total workflow tabs instead of five");
  }
  pass("Three child views map to three distinct native sessions");
  const map = readJson(path.join(run.coordinationRoot, "mapping.json"));
  assert.equal(map.nativeRuns.length, 1);
  const health = await until(
    () => {
      const v = readJson(path.join(run.coordinationRoot, "health.json"));
      return v?.done ? v : undefined;
    },
    "workflow dispatch done",
    30000,
  );
  assert.equal(health.done.outcome, "succeeded");
  pass("All children share exactly one completed Orca workflow dispatch");
  report.status = status.state;
  report.hosts = hosts.map(({ sessionId, agentPid, view }) => ({
    sessionId,
    agentPid,
    view,
  }));
} catch (error) {
  report.error = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  atomicJson(reportFile, report);
  h.close();
  console.log("Workflow report:", reportFile);
}
