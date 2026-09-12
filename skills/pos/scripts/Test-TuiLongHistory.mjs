// Synthetic rendering fixture, explicitly not a transcript of model work.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  cwd,
  readJson,
  atomicJson,
  until,
  orca,
  delay,
} from "./tui-test-utils.mjs";
import { prepareWorkflow, queuedCommand } from "./orca-bridge.mjs";
import { connect } from "../../../src/tui-host/protocol.mjs";
import { createTuiChildSessionFactory } from "../../../src/tui-host/factory.ts";
const sdkRoot = path.join(
  process.env.APPDATA,
  "npm/node_modules/@earendil-works/pi-coding-agent",
);
const Pi = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
const prior = readJson(path.join(path.resolve(process.argv[2]), "result.json"))
  .runs[0];
const template = readJson(
  path.join(
    path.dirname(
      readJson(path.join(prior.asyncDir, "tui/child-0.json")).manifest,
    ),
    "launch.json",
  ),
);
const root = path.join(cwd, "long-history-" + Date.now()),
  runId = randomUUID(),
  asyncDir = path.join(root, "native-fixture"),
  coordinationRoot = path.join(root, "coordination");
fs.mkdirSync(root, { recursive: true });
const report = { fixture: true, checks: [] },
  reportFile = path.join(root, "result.json");
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
  atomicJson(reportFile, report);
};
let child, manifest, map;
try {
  const fixture = Pi.SessionManager.create(cwd, path.join(root, "sessions"));
  for (let n = 0; n < 800; n++) {
    fixture.appendMessage({
      role: "user",
      content:
        `SYNTHETIC_HISTORY_${String(n).padStart(4, "0")} — renderer fixture, not model work. ` +
        "A deliberately long available chat entry. ".repeat(12),
      timestamp: Date.now(),
    });
  }
  fixture.appendMessage({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "SYNTHETIC_HISTORY_END — no model invocation; explicit rendering fixture.",
      },
    ],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionFile = fixture.getSessionFile();
  report.bytes = fs.statSync(sessionFile).size;
  assert(report.bytes > 256 * 1024);
  map = await prepareWorkflow(coordinationRoot, cwd, {
    task: "Model-free Pi TUI rendering integration test: display 800 explicitly synthetic history entries and verify native scrolling. No AI agent task will be executed.",
  });
  const execution = {
    ...template.execution,
    coordinationRoot,
    parentJournal: path.join(root, "journal.json"),
  };
  atomicJson(execution.parentJournal, {});
  process.env.JITI_ALIAS = template.aliases;
  const factory = createTuiChildSessionFactory({
    childExecution: execution,
    asyncDir,
    piPackageRoot: sdkRoot,
  });
  child = await factory.create({
    ...template,
    storage: { kind: "file", sessionFile },
    execution,
    runtime: { ...template.runtime, runId, childIndex: 0 },
    hooks: [],
  });
  manifest = readJson(path.join(asyncDir, "tui/child-0.json")).manifest;
  const host = readJson(manifest),
    c = await connect(manifest),
    snapshot = await c.call("snapshot");
  c.close();
  assert.equal(snapshot.messages.length, 801);
  assert.equal(snapshot.sessionId, fixture.getSessionId());
  pass(
    "The actual child SDK session loads all 801 fixture messages beyond 256 KB",
  );
  const before = await orca([
    "terminal",
    "read",
    "--terminal",
    host.view.handle,
  ]);
  atomicJson(path.join(root, "terminal-end.json"), before);
  assert(JSON.stringify(before).includes("SYNTHETIC_HISTORY_END"));
  await orca([
    "terminal",
    "send",
    "--terminal",
    host.view.handle,
    "--text",
    "\x1b[5~\x1b[H",
  ]);
  await delay(1500);
  const after = await orca([
    "terminal",
    "read",
    "--terminal",
    host.view.handle,
  ]);
  atomicJson(path.join(root, "terminal-start.json"), after);
  assert(JSON.stringify(after).includes("SYNTHETIC_HISTORY_0000"));
  pass("Pi fullscreen PageUp and Home navigate the large available chat");
  const receipts = fs
    .readdirSync(path.join(path.dirname(manifest), "receipts"))
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJson(path.join(path.dirname(manifest), "receipts", n)));
  assert.equal(receipts.filter((r) => r.request.op === "prompt").length, 0);
  pass("Navigation and rendering start no model prompt");
  await child.dispose();
  child = undefined;
  const done = await queuedCommand(map.worker.dir, "fixture-done", [
    "send",
    "--type",
    "worker_done",
    "--subject",
    "Synthetic Pi history rendering verified",
    "--body",
    "The model-free rendering test completed. All 801 fixture messages were loaded and native PageUp reached the first entry. No AI prompt was executed.",
    "--task-id",
    map.taskId,
    "--dispatch-id",
    map.dispatchId,
    "--outcome",
    "succeeded",
  ]);
  assert(done.ok);
} catch (error) {
  report.error = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (child) await child.dispose().catch(() => {});
  if (manifest) {
    const host = readJson(manifest);
    try {
      const c = await connect(manifest);
      await c.call("shutdown");
      c.close();
    } catch {}
    if (host.view?.handle)
      await orca(["terminal", "close", "--terminal", host.view.handle]).catch(
        () => {},
      );
  }
  if (map) {
    if (report.error)
      await queuedCommand(map.worker.dir, "fixture-failed", [
        "send",
        "--type",
        "worker_done",
        "--subject",
        "Synthetic rendering assertion failed",
        "--body",
        report.error,
        "--task-id",
        map.taskId,
        "--dispatch-id",
        map.dispatchId,
        "--outcome",
        "failed",
      ]).catch(() => {});
    for (const role of ["coordinator", "worker"]) {
      fs.writeFileSync(path.join(map[role].dir, "exit"), "");
      await orca([
        "terminal",
        "close",
        "--terminal",
        map[role].terminal.handle,
      ]).catch(() => {});
    }
  }
  atomicJson(reportFile, report);
  console.log("Long-history report:", reportFile);
}
