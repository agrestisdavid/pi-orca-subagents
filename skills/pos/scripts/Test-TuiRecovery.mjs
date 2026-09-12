import { piCliPath } from '../../../src/pos/resources.mjs';
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  readJson,
  atomicJson,
  delay,
} from "../../../src/tui-host/protocol.mjs";
import { command } from "./orca-adapter.mjs";
const previous = path.resolve(process.argv[2]),
  run = readJson(path.join(previous, "result.json")).runs[0],
  ready = readJson(path.join(previous, "ready.json"));
const root = path.join(previous, "recovery");
fs.mkdirSync(root, { recursive: true });
const cwd = path.resolve(process.env.POS_TEST_CWD || "tests/pi-bots-orca"),
  exe = path.join(
    process.env.LOCALAPPDATA,
    "Programs/orca/resources/bin/orca.exe",
  );
const log = fs.openSync(path.join(root, "parent.log"), "w");
const parent = spawn(
  process.execPath,
  [
    piCliPath(),
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    path.resolve("native.ts"),
    "-e",
    path.resolve("skills/pos/scripts/tui-test-host.ts"),
    "--session",
    ready.sessionFile,
    "--no-skills",
    "--no-context-files",
    "--offline",
  ],
  {
    cwd,
    env: { ...process.env, PI_BOTS_TEST_CONTROL: root },
    windowsHide: true,
    stdio: ["pipe", log, log],
  },
);
fs.closeSync(log);
async function until(test, message, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await test();
    if (r) return r;
    await delay(250);
  }
  throw Error(message);
}
async function request(params) {
  const f = path.join(root, "command-" + randomUUID() + ".json");
  atomicJson(f, params);
  const r = await until(() => readJson(f + ".reply.json"), "parent command");
  assert(!r.isError, JSON.stringify(r));
  return r;
}
const result = { run, checks: [] };
const pass = (name) => {
  result.checks.push(name);
  console.log("PASS:", name);
  atomicJson(path.join(root, "result.json"), result);
};
try {
  await until(
    () => readJson(path.join(root, "ready.json")),
    "parent ready",
    60000,
  );
  await request({ action: "status", runId: run.runId });
  pass("Parent restart restores the same native run");
  const pending = await request({ action: "supervisor_pending" });
  assert(pending.details.pending.some((r) => r.runId === run.runId));
  const link = readJson(path.join(run.asyncDir, "tui", "child-0.json")),
    host = readJson(link.manifest);
  const sent = await command(exe, [
    "terminal",
    "send",
    "--terminal",
    host.view.handle,
    "--text",
    "/bot-reply Approved: read README.md and finish.",
    "--enter",
    "--json",
  ]);
  assert(sent.ok, JSON.stringify(sent));
  const status = await until(() => {
    const s = readJson(path.join(run.asyncDir, "status.json"));
    return ["complete", "failed", "stopped"].includes(s?.state) ? s : undefined;
  }, "native completion");
  assert.equal(status.state, "complete", status.error);
  pass("Answer from the Pi TUI completes the native supervisor flow");
  const transcript = fs.readFileSync(host.sessionFile, "utf8");
  assert(transcript.includes("TUI_DIRECT_STEER"));
  pass("Direct input persists in the same native chat");
  const health = await until(
    () => {
      const h = readJson(path.join(run.coordinationRoot, "health.json"));
      return h?.done ? h : undefined;
    },
    "Orca completion",
    30000,
  );
  assert.equal(health.done.outcome, "succeeded");
  pass("Original Orca workflow dispatch reports success");
  result.health = health;
  atomicJson(path.join(root, "result.json"), result);
} catch (error) {
  result.error = String(error.stack || error);
  atomicJson(path.join(root, "result.json"), result);
  console.error(error);
  process.exitCode = 1;
} finally {
  parent.kill();
}
