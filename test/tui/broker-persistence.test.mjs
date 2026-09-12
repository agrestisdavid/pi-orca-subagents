// Process-level regression: a failing host.json store must never be followed
// by a ready/state/prompt/openView success signal. The original error stays
// visible (broadcast, event log, stderr fallback), the host ends terminally
// failed without recursive storage, and cleanup/release keep working — even
// when the event log fails additionally.
// The broker runs as a real process against the fake Orca CLI harness from
// broker-view.test.mjs; the persistence fault is injected into a child
// process preload (host.json rename + optional log appends).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { connect } from "../../src/tui-host/protocol.mjs";

const brokerFile = fileURLToPath(
  new URL("../../src/tui-host/broker.mjs", import.meta.url),
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const STATUS_FAKE = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_ORCA_SCENARIO, "utf8"));
process.stdout.write(JSON.stringify({
  ok: true,
  result: { runtime: { reachable: true, runtimeId: scenario.runtimeId || "rt-1" } },
}) + "\\n");
`;
const TERMINAL_FAKE = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(argv) + "\\n");
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_ORCA_SCENARIO, "utf8"));
const op = argv[0];
const emit = (result) =>
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n");
if (op === "list") {
  const flag = argv.indexOf("--worktree");
  const worktree = flag >= 0 ? String(argv[flag + 1]).replace(/^path:/, "") : "";
  const terminals = (scenario.terminalsByWorktree || {})[worktree] || [];
  emit({ terminals });
} else if (op === "rename") {
  emit({ renamed: true });
} else if (op === "create") {
  emit({ terminal: { handle: "h-new", tabId: "tab-new", paneKey: "tab-new:leaf-new" } });
} else {
  emit({});
}
`;

function fixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-broker-persist-${name}-`));
  const workflowDir = path.join(dir, "workflow");
  const childDir = path.join(dir, "child-worktree");
  const coordinationRoot = path.join(dir, "coordination");
  const root = path.join(dir, "tui", "0-attempt");
  for (const d of [workflowDir, childDir, coordinationRoot, root])
    fs.mkdirSync(d, { recursive: true });
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, "{}");
  const scenarioFile = path.join(dir, "scenario.json");
  fs.writeFileSync(
    scenarioFile,
    JSON.stringify({
      terminalsByWorktree: {
        [workflowDir]: [
          { handle: "h-dispatch", tabId: "tab-w", paneKey: "tab-w:leaf-w" },
        ],
      },
    }),
  );
  const mapping = {
    exe: process.execPath,
    runtimeId: "rt-1",
    cwd: workflowDir,
    worker: {
      dir: workflowDir,
      terminal: { handle: "h-dispatch", tabId: "tab-w", paneKey: "tab-w:leaf-w" },
    },
    tuiViewPolicy: "dispatch-first",
    piBotsSettingsFile: settingsFile,
    nativeRuns: [],
  };
  fs.writeFileSync(
    path.join(coordinationRoot, "mapping.json"),
    JSON.stringify(mapping),
  );
  const launch = {
    cwd: childDir,
    execution: {
      version: 1,
      type: "orca-tui",
      coordinationRoot,
      parentJournal: path.join(dir, "journal.json"),
      todoExtension: path.join(dir, "todo.ts"),
      statusExtension: path.join(dir, "status.ts"),
    },
    runtime: { runId: "run-1", childIndex: 0, agent: "tester" },
    processEnv: {},
    storage: { kind: "none" },
  };
  fs.writeFileSync(path.join(root, "launch.json"), JSON.stringify(launch));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(dir, "status"), STATUS_FAKE);
  fs.writeFileSync(path.join(dir, "terminal"), TERMINAL_FAKE);
  // Preload injected into the broker child: permanent EPERM on host.json
  // renames (and, when the all-lock marker exists, on the event logs) once
  // the marker file appears.
  const preload = path.join(dir, "persistence-fault.mjs");
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
const append = fs.appendFileSync;
fs.renameSync = (src, dest) => {
  const marker = process.env.PERSIST_LOCK_MARKER;
  if (
    marker &&
    path.basename(dest) === 'host.json' &&
    (fs.existsSync(marker) ||
      (fs.existsSync(marker + '.creating') && JSON.parse(fs.readFileSync(src, 'utf8')).viewState === 'creating'))
  )
    throw Object.assign(
      new Error('PERSISTENCE_TEST host.json EPERM (injected)'),
      { code: 'EPERM' },
    );
  return rename(src, dest);
};
fs.appendFileSync = (file, data, opts) => {
  const all = process.env.PERSIST_LOCK_ALL;
  if (
    all &&
    fs.existsSync(all) &&
    /broker-events\\.jsonl$|control-events\\.jsonl$/.test(file)
  )
    throw Object.assign(
      new Error('PERSISTENCE_TEST log EPERM (injected)'),
      { code: 'EPERM' },
    );
  return append(file, data, opts);
};
syncBuiltinESMExports();
`,
  );
  return {
    dir,
    root,
    workflowDir,
    childDir,
    coordinationRoot,
    manifest: path.join(root, "host.json"),
    preload,
    markerFile: path.join(dir, "inject-lock"),
    allMarkerFile: path.join(dir, "inject-all"),
  };
}

function startBroker(fx) {
  const child = spawn(process.execPath, [brokerFile, fx.root], {
    cwd: fx.dir,
    env: {
      ...process.env,
      FAKE_ORCA_SCENARIO: path.join(fx.dir, "scenario.json"),
      FAKE_ORCA_LOG: path.join(fx.dir, "orca-calls.jsonl"),
      NODE_OPTIONS:
        (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : "") +
        `--import=${pathToFileURL(fx.preload).href}`,
      PERSIST_LOCK_MARKER: fx.markerFile,
      PERSIST_LOCK_ALL: fx.allMarkerFile,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  return { child, output: () => output };
}

const readHost = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
async function waitFor(predicate, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs)
      throw new Error("waitFor timed out");
    await delay(100);
  }
}

async function cleanup(fx, child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise((r) => child.once("close", r));
  }
  await delay(150);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

test("a failed host.json save turns the host terminally failed without any ready signal", async (t) => {
  const fx = fixture("ready-fail");
  const { child, output } = startBroker(fx);
  t.after(async () => cleanup(fx, child));
  await waitFor(() => readHost(fx.manifest)?.port, 20000);
  await waitFor(() => readHost(fx.manifest)?.dispatchViewRenamed);

  const control = await connect(fx.manifest, "control");
  t.after(() => control.close());
  const agentPeer = await connect(fx.manifest, "agent");
  t.after(() => agentPeer.close());
  const events = [];
  control.events.on("message", (m) => events.push(m));
  await control.call("replay", { after: 0 });

  // Healthy ready round-trip before the fault: store and transport agree.
  agentPeer.send({
    kind: "ready",
    session: { sessionId: "sess-1", sessionFile: "C:/tmp/sess.json" },
  });
  await waitFor(() => readHost(fx.manifest)?.state === "ready");
  assert.ok(events.some((m) => m.kind === "ready"));

  // Now arm the permanent store fault and send ready again: no ready
  // broadcast may follow, the host must end failed with the original error.
  fs.writeFileSync(fx.markerFile, "1");
  agentPeer.send({
    kind: "ready",
    session: { sessionId: "sess-2", sessionFile: "C:/tmp/sess-2.json" },
  });
  const failedEvent = await waitFor(() =>
    events.find((m) => m.kind === "failed"),
  );
  assert.match(failedEvent.error, /PERSISTENCE_TEST host\.json EPERM \(injected\)/);
  assert.ok(
    !events.some((m) => m.kind === "ready" && m.session?.sessionId === "sess-2"),
    "no ready event may follow a failed store write",
  );
  // The disk still holds the last healthy state — the on-disk lag is real,
  // but the failure is visible to every caller.
  assert.equal(readHost(fx.manifest)?.state, "ready");
  const status = await control.call("status", {}, { timeout: 5000 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /PERSISTENCE_TEST host\.json EPERM \(injected\)/);
  // The event log carries the original error (disk for logs is still fine).
  const brokerEvents = fs
    .readFileSync(path.join(fx.root, "broker-events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.ok(
    brokerEvents.some((l) => l.includes('"failed"') && l.includes("PERSISTENCE_TEST")),
    "original error must stay in the broker event log",
  );
  // No new agent was started as error handling.
  assert.ok(!fs.existsSync(path.join(fx.root, "terminal.ansi")));

  // A prompt must not be confirmed either (call() rejects on ok:false).
  await assert.rejects(
    control.call("prompt", { text: "must not be accepted" }, { timeout: 5000 }),
    /persistence failed|terminally failed/i,
  );

  // Recovery of the filesystem must not revive an already failed host.
  fs.unlinkSync(fx.markerFile);
  let forwardedWork = 0;
  agentPeer.events.on("message", (message) => {
    if (message.kind !== "request") return;
    if (["prompt", "steer", "followUp"].includes(message.op)) forwardedWork++;
    agentPeer.send({ kind: "reply", id: message.id, ok: true, result: {} });
  });
  for (const op of ["prompt", "steer", "followUp", "openView"])
    await assert.rejects(control.call(op, {}, { timeout: 5000 }), /PERSISTENCE_TEST/);
  assert.equal(forwardedWork, 0);
  agentPeer.send({ kind: "ready", session: { sessionId: "late-ready" } });
  agentPeer.send({ kind: "state", state: { state: "settled" } });
  await waitFor(() => fs.readFileSync(path.join(fx.root, "broker-events.jsonl"), "utf8").includes('"ignored":"state"'));
  await control.call("release", {}, { timeout: 5000 });
  const afterRecovery = await control.call("status", {}, { timeout: 5000 });
  assert.equal(afterRecovery.state, "failed");
  assert.equal(afterRecovery.error, failedEvent.error);
  assert.equal(afterRecovery.executionReleased, true);

  // Release and cleanup stay possible in the failed state.
  await control.call("shutdown", {}, { timeout: 5000 });
  const exitCode = await new Promise((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  assert.equal(exitCode, 0);
});

test("the original failure stays visible when the event logs fail additionally", async (t) => {
  const fx = fixture("log-fail");
  const { child, output } = startBroker(fx);
  t.after(async () => cleanup(fx, child));
  await waitFor(() => readHost(fx.manifest)?.port, 20000);
  await waitFor(() => readHost(fx.manifest)?.dispatchViewRenamed);

  const control = await connect(fx.manifest, "control");
  t.after(() => control.close());
  const agentPeer = await connect(fx.manifest, "agent");
  t.after(() => agentPeer.close());
  const events = [];
  control.events.on("message", (m) => events.push(m));
  await control.call("replay", { after: 0 });

  // Arm both the store fault and the log fault, then trigger a save.
  fs.writeFileSync(fx.markerFile, "1");
  fs.writeFileSync(fx.allMarkerFile, "1");
  agentPeer.send({
    kind: "ready",
    session: { sessionId: "sess-x", sessionFile: "C:/tmp/sess-x.json" },
  });
  const failedEvent = await waitFor(() =>
    events.find((m) => m.kind === "failed"),
  );
  assert.match(failedEvent.error, /PERSISTENCE_TEST host\.json EPERM \(injected\)/);
  assert.ok(
    !events.some((m) => m.kind === "ready"),
    "no ready event may follow a failed store write",
  );
  // The event log is locked, so the stderr fallback must carry the error.
  await waitFor(() => output().includes("PERSISTENCE_TEST host.json EPERM"));
  assert.match(output(), /event log unavailable/);
  const status = await control.call("status", {}, { timeout: 5000 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /PERSISTENCE_TEST host\.json EPERM \(injected\)/);

  // Cleanup stays possible with both store and logs broken.
  await control.call("shutdown", {}, { timeout: 5000 });
  const exitCode = await new Promise((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  assert.equal(exitCode, 0);
});

test("a failed view-creation save issues no terminal-create command", async (t) => {
  const fx = fixture("create-fail");
  const mappingFile = path.join(fx.coordinationRoot, "mapping.json");
  const mapping = JSON.parse(fs.readFileSync(mappingFile, "utf8"));
  mapping.tuiViewPolicy = "dedicated";
  fs.writeFileSync(mappingFile, JSON.stringify(mapping));
  fs.writeFileSync(fx.markerFile + ".creating", "1");
  const { child } = startBroker(fx);
  t.after(async () => cleanup(fx, child));
  await waitFor(() => readHost(fx.manifest)?.port);
  const control = await connect(fx.manifest, "control");
  t.after(() => control.close());
  await waitFor(() => fs.existsSync(path.join(fx.root, "broker-events.jsonl")));
  const status = await control.call("status", {}, { timeout: 5000 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /PERSISTENCE_TEST/);
  await assert.rejects(control.call("openView", {}, { timeout: 5000 }), /PERSISTENCE_TEST/);
  await control.call("shutdown", {}, { timeout: 5000 });
  await new Promise((resolve) => child.once("close", resolve));
  const callsFile = path.join(fx.dir, "orca-calls.jsonl");
  const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse) : [];
  assert.equal(calls.some((args) => args[0] === "create"), false);
});
