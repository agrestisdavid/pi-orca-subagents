import { piCliPath } from '../../../src/pos/resources.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { command, atomicJson } from "./orca-adapter.mjs";
import {
  connect,
  readJson,
  delay,
} from "../../../src/tui-host/protocol.mjs";
const cwd = path.resolve(process.env.POS_TEST_CWD || "tests/pi-bots-orca");
const root = path.join(cwd, "lifecycle-" + Date.now());
fs.mkdirSync(root, { recursive: true });
// This regression intentionally exercises detachable legacy child panes.
atomicJson(path.join(root,'pi-bots-settings.json'),{piBots:{stopOnTabClose:false}});
const exe = path.join(
  process.env.LOCALAPPDATA,
  "Programs/orca/resources/bin/orca.exe",
);
const results = { root, checks: [], runs: [] };
const check = (name, value) => {
  assert(value, name);
  results.checks.push(name);
  atomicJson(path.join(root, "result.json"), results);
  console.log("PASS:", name);
};
async function until(test, message, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await test();
    if (value) return value;
    await delay(250);
  }
  throw Error("Timed out: " + message);
}
function startHost(sessionFile) {
  const log = fs.openSync(
    path.join(root, sessionFile ? "parent-reloaded.log" : "parent.log"),
    "w",
  );
  const args = [
    piCliPath(),
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    path.resolve("native.ts"),
    "-e",
    path.resolve("skills/pos/scripts/tui-test-host.ts"),
    "--no-skills",
    "--no-context-files",
    "--offline",
  ];
  if (sessionFile) args.push("--session", sessionFile);
  else args.push("--session-dir", path.join(root, "sessions"));
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, PI_BOTS_TEST_CONTROL: root },
    windowsHide: true,
    stdio: ["pipe", log, log],
  });
  fs.closeSync(log);
  return child;
}
async function request(params) {
  const file = path.join(root, "command-" + randomUUID() + ".json");
  atomicJson(file, params);
  const reply = await until(
    () => readJson(file + ".reply.json"),
    "parent command " + params.action,
    150000,
  );
  if (reply.isError) throw Error(JSON.stringify(reply));
  return reply;
}
async function orca(args) {
  const result = await command(exe, [...args, "--json"]);
  assert(result.ok, JSON.stringify(result));
  return result.data.result;
}
let parent = startHost();
try {
  const ready = await until(
    () => readJson(path.join(root, "ready.json")),
    "parent ready",
    60000,
  );
  const start = await request({
    action: "start",
    execution: "orca-tui",
    dispatchView: "separate",
    coordination: "orca",
    viewMode: "orca",
    launch: {
      agent: "scout",
      context: "fresh",
      cwd,
      task: 'Use todo to plan reading README.md. Before reading, use contact_supervisor with reason need_decision and message "TUI lifecycle test: may I read README.md?". Wait for the supervisor answer. Then read only README.md, finish the todo and report its single sentence. Do not start other agents.',
    },
  });
  const run = {
    runId: start.details.runId,
    asyncDir: start.details.asyncDir,
    coordinationRoot: start.details.coordination.root,
  };
  results.runs.push(run);
  atomicJson(path.join(root, "result.json"), results);
  const link = await until(
    () => readJson(path.join(run.asyncDir, "tui", "child-0.json")),
    "child host descriptor",
  );
  let host = await until(() => {
    const h = readJson(link.manifest);
    const s = readJson(path.join(run.asyncDir, "status.json"));
    if (s?.state === "failed") throw Error(s.error);
    return h?.sessionId && h.state === "running" ? h : undefined;
  }, "actual Pi TUI running");
  const initial = {
    sessionId: host.sessionId,
    agentPid: host.agentPid,
    view: host.view,
  };
  const shown = await orca([
    "terminal",
    "show",
    "--terminal",
    host.view.handle,
  ]);
  check(
    "Orca recognizes the real child as Pi",
    shown.terminal.agentIdentity === "pi",
  );
  const pending = await until(async () => {
    const r = await request({ action: "supervisor_pending" });
    return r.details?.pending?.[0];
  }, "native supervisor question");
  results.question = pending;
  atomicJson(path.join(root, "result.json"), results);
  await orca(["terminal", "close", "--terminal", host.view.handle]);
  await delay(1000);
  const channel = await connect(link.manifest);
  const detached = await channel.call("status");
  channel.close();
  check(
    "Closing the Orca tab keeps the same child running",
    detached.state === "running" &&
      detached.agentPid === initial.agentPid &&
      detached.sessionId === initial.sessionId,
  );
  await request({ action: "sync_views", runId: run.runId });
  host = await until(() => {
    const h = readJson(link.manifest);
    return h?.viewState === "attached" && h.view.handle !== initial.view.handle
      ? h
      : undefined;
  }, "reattached tab");
  check(
    "Reopening attaches to the same Pi process and session",
    host.agentPid === initial.agentPid && host.sessionId === initial.sessionId,
  );
  await orca([
    "terminal",
    "send",
    "--terminal",
    host.view.handle,
    "--text",
    "TUI_DIRECT_STEER: Include the exact token TUI_DIRECT_STEER in your final answer.",
    "--enter",
  ]);
  let parentSteer = false;
  try {
    await request({
      action: "steer",
      runId: run.runId,
      index: 0,
      message:
        "PARENT_STEER: Include the exact token PARENT_STEER in your final answer.",
    });
    parentSteer = true;
  } catch (error) {
    check(
      "Native steering preserves the pending-question guard",
      String(error).includes("blocked on a pending supervisor ask"),
    );
  }
  parent.kill();
  await new Promise((resolve) => parent.once("exit", resolve));
  fs.renameSync(
    path.join(root, "ready.json"),
    path.join(root, "ready-before-reload.json"),
  );
  parent = startHost(ready.sessionFile);
  await until(
    () => readJson(path.join(root, "ready.json")),
    "reloaded parent ready",
    60000,
  );
  check(
    "Parent reload restores the original native run",
    Boolean(
      (await request({ action: "status", runId: run.runId })).details.views,
    ),
  );
  await orca([
    "terminal",
    "send",
    "--terminal",
    host.view.handle,
    "--text",
    "/bot-reply Approved: read README.md and finish.",
    "--enter",
  ]);
  const status = await until(() => {
    const s = readJson(path.join(run.asyncDir, "status.json"));
    return ["complete", "failed", "stopped", "partial"].includes(s?.state)
      ? s
      : undefined;
  }, "workflow completion");
  check(
    "TUI supervisor reply completes the native workflow",
    status.state === "complete",
  );
  const transcript = fs.readFileSync(host.sessionFile, "utf8");
  check(
    "Direct TUI input belongs to the native child chat",
    transcript.includes("TUI_DIRECT_STEER") &&
      (!parentSteer || transcript.includes("PARENT_STEER")),
  );
  check(
    "Todo plan and completion are real session tool events",
    transcript.includes('"toolName":"todo"') &&
      transcript.includes('"completed"'),
  );
  const map = readJson(path.join(run.coordinationRoot, "mapping.json"));
  const health = await until(
    () => {
      const h = readJson(path.join(run.coordinationRoot, "health.json"));
      return h?.done ? h : undefined;
    },
    "Orca worker_done",
    30000,
  );
  check(
    "One Orca dispatch settles the whole native workflow",
    map.nativeRuns.length === 1 && health.done.outcome === "succeeded",
  );
  results.completedAt = Date.now();
  atomicJson(path.join(root, "result.json"), results);
  console.log("Lifecycle report:", path.join(root, "result.json"));
} catch (error) {
  results.error = String(error.stack || error);
  atomicJson(path.join(root, "result.json"), results);
  console.error(error);
  process.exitCode = 1;
} finally {
  parent.kill();
}
