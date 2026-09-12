import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  harness,
  readJson,
  atomicJson,
  until,
  orca,
} from "./tui-test-utils.mjs";
const previous = path.resolve(process.argv[2]),
  prior = readJson(path.join(previous, "result.json")),
  run = prior.runs.at(-1),
  ready = readJson(path.join(previous, "ready.json"));
const h = await harness("stop-recovery", { sessionFile: ready.sessionFile }),
  report = { run, checks: [] };
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
  atomicJson(path.join(h.root, "result.json"), report);
};
try {
  await h.request({ action: "stop", runId: run.runId });
  const status = await until(() => {
    const s = readJson(path.join(run.asyncDir, "status.json"));
    return ["stopped", "failed", "partial"].includes(s?.state) ? s : undefined;
  }, "native stopped workflow");
  pass("Native Stop works after parent restart during a transport outage");
  const marker = path.join(run.coordinationRoot, "connection-pause");
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  const done = await until(
    () => readJson(path.join(run.coordinationRoot, "health.json"))?.done,
    "original Orca completion",
    30000,
  );
  assert.equal(done.outcome, "failed");
  pass("Original Orca dispatch receives failure after reconnection");
  const map = readJson(path.join(run.coordinationRoot, "mapping.json"));
  report.dispatch = await orca([
    "orchestration",
    "dispatch-show",
    "--task",
    map.taskId,
  ]);
  report.tasks = await orca([
    "orchestration",
    "task-list",
    "--run",
    map.orcaRunId,
  ]);
  pass("Real Orca task and dispatch records confirm the association");
} catch (error) {
  report.error = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  atomicJson(path.join(h.root, "result.json"), report);
  h.close();
  console.log("Stop report:", h.root);
}
