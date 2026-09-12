import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  harness,
  readJson,
  atomicJson,
  until,
  delay,
} from "./tui-test-utils.mjs";
const prior = path.resolve(process.argv[2]);
const old = readJson(path.join(prior, "result.json")).runs[0];
const originalSession = readJson(path.join(prior, "ready.json")).sessionFile;
let h = await harness("lost-resume", {
  sessionFile: originalSession,
  env: { PI_BOTS_TEST_DROP_RESUME_REPLY: "1" },
});
const report = { previous: old, checks: [] },
  reportFile = path.join(h.root, "result.json");
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
  atomicJson(reportFile, report);
};
try {
  const original = readJson(
    path.join(
      readJson(path.join(old.asyncDir, "tui", "child-0.json")).attemptDir ||
        old.asyncDir,
      "host.json",
    ),
  );
  const oldLink = readJson(path.join(old.asyncDir, "tui", "child-0.json")),
    oldHost = readJson(oldLink.manifest);
  const oldState = readJson(path.join(old.asyncDir, "status.json")).state;
  atomicJson(path.join(h.root, "command-" + randomUUID() + ".json"), {
    action: "resume",
    runId: old.runId,
    index: 0,
    message:
      "Continue the same conversation. Create your own short todo plan. Ask contact_supervisor whether you may read README.md, wait for approval, then read it, complete the todo and report LOST_RESUME_CONFIRMED with the sentence.",
  });
  const lost = await until(
    () => readJson(path.join(h.root, "dropped-reply.json")),
    "lost resume reply",
  );
  assert(lost.success, JSON.stringify(lost.error));
  const next = {
    runId: lost.data.details.runId || lost.data.details.asyncId,
    asyncDir: lost.data.details.asyncDir,
  };
  report.next = next;
  report.requestId = lost.requestId;
  h.close();
  await delay(500);
  h = await harness("lost-resume-reload", { sessionFile: originalSession });
  await until(
    async () =>
      Boolean(
        (await h.request({ action: "status", runId: next.runId })).details
          .views,
      ),
    "resume receipt recovery",
  );
  pass("Aborted parent recovers the original resume receipt");
  const nextLink = await until(
    () => readJson(path.join(next.asyncDir, "tui", "child-0.json")),
    "resumed child",
  );
  const nextHost = await until(() => {
    const host = readJson(nextLink.manifest);
    return host?.sessionId ? host : undefined;
  }, "resumed session identity");
  assert.equal(nextHost.sessionId, oldHost.sessionId);
  assert.equal(nextHost.sessionFile, oldHost.sessionFile);
  assert(readJson(oldLink.manifest).exitObservedAt);
  pass(
    "Exactly one resumed session writer replaces the confirmed closed attempt",
  );
  const question = await until(
    async () =>
      (await h.request({ action: "supervisor_pending" })).details.pending.find(
        (q) => q.runId === next.runId,
      ),
    "resumed native question",
  );
  await h.request({
    action: "supervisor_reply",
    replyTo: question.id,
    message: "Approved: read README.md and finish.",
  });
  const status = await until(() => {
    const s = readJson(path.join(next.asyncDir, "status.json"));
    return ["complete", "failed", "stopped"].includes(s?.state) ? s : undefined;
  }, "resumed completion");
  assert.equal(status.state, "complete");
  const map = readJson(path.join(nextHost.coordinationRoot, "mapping.json"));
  assert.equal(map.nativeRuns.length, 1);
  assert.equal(
    readJson(path.join(old.asyncDir, "status.json")).state,
    oldState,
  );
  pass(
    "Lost resume response creates one new workflow dispatch and leaves old result unchanged",
  );
  const receipts = fs
    .readdirSync(path.join(path.dirname(nextLink.manifest), "receipts"))
    .filter((n) => n.endsWith(".json"))
    .map((n) =>
      readJson(path.join(path.dirname(nextLink.manifest), "receipts", n)),
    );
  assert.equal(receipts.filter((r) => r.request.op === "prompt").length, 1);
  pass("Resume recovery never repeats the model prompt");
} catch (error) {
  report.error = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  atomicJson(reportFile, report);
  h.close();
  console.log("Lost-resume report:", reportFile);
}
