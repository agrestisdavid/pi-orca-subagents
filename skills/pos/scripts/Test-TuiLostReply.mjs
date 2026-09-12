import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  harness,
  cwd,
  readJson,
  atomicJson,
  until,
  delay,
} from "./tui-test-utils.mjs";
import { connect } from "../../../src/tui-host/protocol.mjs";
let h = await harness("lost-reply", {
  env: { PI_BOTS_TEST_DROP_SPAWN_REPLY: "1" },
});
const report = { checks: [] },
  reportFile = path.join(h.root, "result.json");
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
  atomicJson(reportFile, report);
};
try {
  atomicJson(path.join(h.root, "command-" + randomUUID() + ".json"), {
    action: "start",
    execution: "orca-tui",
    coordination: "orca",
    viewMode: "orca",
    launch: {
      agent: "scout",
      cwd,
      context: "fresh",
      task: "Use todo to plan one small read. Ask contact_supervisor whether you may read README.md and wait for approval. Then read README.md, mark the todo complete and report the sentence. Do not start other agents.",
    },
  });
  const lost = await until(
    () => readJson(path.join(h.root, "dropped-reply.json")),
    "lost native start reply",
  );
  assert(lost.success);
  const run = {
    runId: lost.data.details.runId,
    asyncDir: lost.data.details.asyncDir,
  };
  report.run = run;
  const originalRequest = lost.requestId,
    ready = readJson(path.join(h.root, "ready.json"));
  h.close();
  await delay(500);
  h = await harness("lost-reply-reload", { sessionFile: ready.sessionFile });
  await until(
    async () =>
      Boolean(
        (await h.request({ action: "status", runId: run.runId })).details.views,
      ),
    "durable receipt recovery",
  );
  pass("Parent restart recovers the original dropped native RPC receipt");
  const question = await until(
    async () =>
      (await h.request({ action: "supervisor_pending" })).details.pending[0],
    "native question",
  );
  const link = readJson(path.join(run.asyncDir, "tui", "child-0.json")),
    host = readJson(link.manifest);
  const c = await connect(link.manifest);
  await c.call("diagnosticDropControl");
  c.close();
  await delay(600);
  assert.equal(readJson(link.manifest).agentPid, host.agentPid);
  pass("Losing the local control connection keeps the same Pi process");
  await h.request({
    action: "supervisor_reply",
    replyTo: question.id,
    message: "Approved: read README.md and finish.",
  });
  const status = await until(() => {
    const s = readJson(path.join(run.asyncDir, "status.json"));
    return ["complete", "failed", "stopped"].includes(s?.state) ? s : undefined;
  }, "reconnected native result");
  assert.equal(status.state, "complete", status.error);
  pass(
    "Replayed events and the original prompt receipt settle the same native run",
  );
  const receipts = fs
    .readdirSync(path.join(path.dirname(link.manifest), "receipts"))
    .filter((n) => n.endsWith(".json"))
    .map((n) =>
      readJson(path.join(path.dirname(link.manifest), "receipts", n)),
    );
  assert.equal(receipts.filter((r) => r.request.op === "prompt").length, 1);
  pass("A lost connection does not create a second model prompt");
  const map = readJson(path.join(host.coordinationRoot, "mapping.json"));
  assert.equal(map.nativeRuns.length, 1);
  report.originalRequest = originalRequest;
  report.taskId = map.taskId;
  pass("The original start still has exactly one Orca dispatch");
} catch (error) {
  report.error = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  atomicJson(reportFile, report);
  h.close();
  console.log("Lost-reply report:", reportFile);
}
