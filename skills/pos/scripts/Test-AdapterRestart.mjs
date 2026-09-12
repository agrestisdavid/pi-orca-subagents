import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  cwd,
  atomicJson,
  readJson,
  until,
  orca,
  delay,
} from "./tui-test-utils.mjs";
import {
  prepareWorkflow,
  attachNative,
  recoverWorkflowAdapters,
} from "./orca-bridge.mjs";
const root = path.join(cwd, "adapter-restart-" + Date.now()),
  report = { checks: [] };
let map;
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
  atomicJson(path.join(root, "result.json"), report);
};
try {
  map = await prepareWorkflow(root, cwd, {
    task: "Model-free durability test: restart only the two owned Pi Bots protocol adapters and verify the original workflow dispatch accepts completion. Native status is an explicitly synthetic test fixture.",
  });
  const dir = path.join(root, "native-fixture");
  atomicJson(path.join(dir, "status.json"), {
    runId: "adapter-restart-fixture",
    cwd,
    state: "running",
    steps: [],
  });
  attachNative(
    root,
    { runId: "adapter-restart-fixture", asyncDir: dir },
    path.join(root, "supervisor"),
  );
  await until(
    () => readJson(path.join(root, "health.json"))?.connected,
    "original connection",
  );
  const old = [];
  for (const role of ["coordinator", "worker"]) {
    const endpoint = map[role],
      hello = readJson(path.join(endpoint.dir, "hello.json")),
      daemon = readJson(path.join(endpoint.dir, "daemon.json"));
    assert.equal(hello.version, 2);
    assert.equal(hello.pid, daemon.pid);
    assert.equal(hello.identity.ORCA_PANE_KEY, endpoint.terminal.paneKey);
    old.push(daemon.pid);
    process.kill(daemon.pid);
  }
  await delay(500);
  await recoverWorkflowAdapters(root);
  await until(
    () =>
      ["coordinator", "worker"].every((role, i) => {
        const hello = readJson(path.join(map[role].dir, "hello.json"));
        return hello?.pid !== old[i] && Date.now() - hello.updatedAt < 10000;
      }),
    "owned adapter restart",
  );
  pass(
    "Only confirmed dead protocol adapters restart in their original Orca panes",
  );
  atomicJson(path.join(dir, "status.json"), {
    runId: "adapter-restart-fixture",
    cwd,
    state: "complete",
    steps: [],
  });
  const done = await until(
    () => readJson(path.join(root, "health.json"))?.done,
    "original dispatch completion",
  );
  assert.equal(done.outcome, "succeeded");
  pass(
    "Durable messages complete the original dispatch after adapter process loss",
  );
  const tasks = await orca([
    "orchestration",
    "task-list",
    "--run",
    map.orcaRunId,
    "--from",
    map.coordinator.terminal.handle,
  ]);
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].status, "completed");
  const dispatch = await orca([
    "orchestration",
    "dispatch-show",
    "--task",
    map.taskId,
    "--from",
    map.coordinator.terminal.handle,
  ]);
  assert.equal(dispatch.dispatch.id, map.dispatchId);
  pass("Recovery creates no new task or dispatch");
  report.taskId = map.taskId;
  report.dispatch = dispatch;
} catch (error) {
  report.error = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  atomicJson(path.join(root, "result.json"), report);
  if (map)
    for (const role of ["coordinator", "worker"]) {
      fs.writeFileSync(path.join(map[role].dir, "exit"), "");
      await orca([
        "terminal",
        "close",
        "--terminal",
        map[role].terminal.handle,
      ]).catch(() => {});
    }
  console.log("Adapter-restart report:", path.join(root, "result.json"));
}
