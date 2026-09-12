import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import {
  harness,
  readJson,
  atomicJson,
  until,
  orca,
} from "./tui-test-utils.mjs";
const prior = path.resolve(process.argv[2]);
const old = readJson(path.join(prior, "result.json")).runs[0];
const parentSession = readJson(path.join(prior, "ready.json"));
const h = await harness("resume", { sessionFile: parentSession.sessionFile }),
  report = { previous: old, checks: [] };
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
  atomicJson(path.join(h.root, "result.json"), report);
};
try {
  const oldStatus = readJson(path.join(old.asyncDir, "status.json"));
  const link = readJson(path.join(old.asyncDir, "tui", "child-0.json")),
    oldHost = readJson(link.manifest);
  const result = await h.request({
    _native: {
      method: "resume",
      params: {
        id: old.runId,
        index: 0,
        message:
          "Continue in this same session. Use todo for one short verification task, read README.md, mark it done and reply RESUME_CONFIRMED with the fixture sentence.",
      },
    },
  });
  const next = {
    runId: result.details.details.runId || result.details.details.asyncId,
    asyncDir: result.details.details.asyncDir,
  };
  report.next = next;
  assert(next.runId && next.asyncDir);
  pass("Native resume routes through the owned Pi Bots workflow");
  const nextLink = await until(
    () => readJson(path.join(next.asyncDir, "tui", "child-0.json")),
    "resume TUI descriptor",
  );
  const nextHost = await until(() => {
    const value = readJson(nextLink.manifest);
    const status = readJson(path.join(next.asyncDir, "status.json"));
    if (status?.state === "failed")
      throw Error(JSON.stringify(status.steps?.map((s) => s.error)));
    return value?.sessionId ? value : undefined;
  }, "resumed Pi session");
  assert.equal(nextHost.sessionId, oldHost.sessionId);
  assert.equal(nextHost.sessionFile, oldHost.sessionFile);
  pass("Resume keeps the exact native Pi session");
  const retired = readJson(link.manifest);
  assert(retired.exitObservedAt);
  assert.notEqual(nextHost.agentPid, oldHost.agentPid);
  pass("Previous attempt exits before the new session writer starts");
  const status = await until(() => {
    const s = readJson(path.join(next.asyncDir, "status.json"));
    return ["complete", "failed", "stopped"].includes(s?.state) ? s : undefined;
  }, "resume completion");
  assert.equal(status.state, "complete");
  const map = readJson(path.join(nextHost.coordinationRoot, "mapping.json"));
  assert.notEqual(
    map.taskId,
    readJson(path.join(old.coordinationRoot, "mapping.json")).taskId,
  );
  assert.deepEqual(
    readJson(path.join(old.asyncDir, "status.json")).state,
    oldStatus.state,
  );
  pass("Completed workflow is immutable and resume has its own dispatch");
  assert(
    fs.readFileSync(nextHost.sessionFile, "utf8").includes("RESUME_CONFIRMED"),
  );
  pass("Follow-up chat is persisted in the same session");
  const show = await orca([
    "terminal",
    "show",
    "--terminal",
    nextHost.view.handle,
  ]);
  assert.equal(show.terminal.agentIdentity, "pi");
  pass("Resumed TUI is recognized as Pi");
} catch (error) {
  report.error = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  atomicJson(path.join(h.root, "result.json"), report);
  h.close();
  console.log("Resume report:", h.root);
}
