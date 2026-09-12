// Process-level regression tests for the TUI host broker (create-beta).
// The broker runs against a fake Orca CLI: mapping.exe is the Node executable
// and the fixture directory holds scripts named after the subcommands
// ('status', 'terminal'), so the broker's spawn works without a real Orca.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect } from "../../src/tui-host/protocol.mjs";

const brokerFile = fileURLToPath(
  new URL("../../src/tui-host/broker.mjs", import.meta.url),
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const STATUS_FAKE = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_ORCA_LOG)
  fs.appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(argv) + "\\n");
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_ORCA_SCENARIO, "utf8"));
if (scenario.statusError) {
  process.stderr.write("orca runtime down\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  ok: true,
  result: { runtime: { reachable: true, runtimeId: scenario.runtimeId || "rt-1" } },
}) + "\\n");
`;
const TERMINAL_FAKE = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_ORCA_LOG)
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-broker-${name}-`));
  const workflowDir = path.join(dir, "workflow");
  const childDir = path.join(dir, "child-worktree");
  const coordinationRoot = path.join(dir, "coordination");
  const root = path.join(dir, "tui", "0-attempt");
  for (const d of [workflowDir, childDir, coordinationRoot, root])
    fs.mkdirSync(d, { recursive: true });
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, "{}");
  const scenarioFile = path.join(dir, "scenario.json");
  fs.writeFileSync(scenarioFile, JSON.stringify({ terminalsByWorktree: {} }));
  const logFile = path.join(dir, "fake-orca-calls.jsonl");
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
  return {
    dir,
    root,
    workflowDir,
    childDir,
    coordinationRoot,
    manifest: path.join(root, "host.json"),
    logFile,
  };
}

function startBroker(fx) {
  const child = spawn(process.execPath, [brokerFile, fx.root], {
    cwd: fx.dir,
    env: {
      ...process.env,
      FAKE_ORCA_SCENARIO: path.join(fx.dir, "scenario.json"),
      FAKE_ORCA_LOG: fx.logFile,
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
async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs)
      throw new Error("waitFor timed out");
    await delay(100);
  }
}
const fakeCalls = (fx) =>
  fs.existsSync(fx.logFile)
    ? fs
        .readFileSync(fx.logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];


async function cleanup(fx, child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise((r) => child.once('close', r));
  }
  await delay(150);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

test("dispatch tab is reconciled in the workflow area, not the child worktree", async (t) => {
  // create-beta regression: the assigned dispatch tab belongs to the workflow
  // area while the child works in its own worktree. The old code listed
  // terminals in the child worktree, misread the dispatch tab as closed, and
  // failed startup with "native stop enabled".
  const fx = fixture("dispatch-area");
  fs.writeFileSync(
    path.join(fx.dir, "scenario.json"),
    JSON.stringify({
      terminalsByWorktree: {
        [fx.workflowDir]: [
          { handle: "h-dispatch", tabId: "tab-w", paneKey: "tab-w:leaf-w" },
        ],
        [fx.childDir]: [],
      },
    }),
  );
  const { child } = startBroker(fx);
  t.after(async () => cleanup(fx, child));
  await waitFor(() => readHost(fx.manifest)?.port, 15000);
  const agentPeer = await connect(fx.manifest, "agent");
  t.after(() => agentPeer.close());
  agentPeer.send({
    kind: "ready",
    session: { sessionId: "sess-1", sessionFile: "C:/tmp/sess.json" },
  });
  const host = await waitFor(() => {
    const h = readHost(fx.manifest);
    return h?.state === "ready" && h?.dispatchViewRenamed === true ? h : undefined;
  });
  assert.equal(host.view.paneKey, "tab-w:leaf-w");
  assert.equal(host.view.handle, "h-dispatch");
  assert.equal(host.dispatchViewRenamed, true);
  assert.equal(host.tabClose, undefined);
  const calls = fakeCalls(fx);
  const lists = calls.filter((a) => a[0] === "list");
  assert.ok(lists.length >= 1, "expected a terminal list probe");
  for (const a of lists)
    assert.equal(
      a[a.indexOf("--worktree") + 1],
      `path:${fx.workflowDir}`,
      "existence check must query the workflow area",
    );
});

test("a really closed dispatch tab is confirmed after two consecutive misses", async (t) => {
  const fx = fixture("dispatch-closed");
  const { child } = startBroker(fx);
  t.after(async () => cleanup(fx, child));
  await waitFor(() => readHost(fx.manifest)?.port, 15000);
  const host = await waitFor(() => {
    const h = readHost(fx.manifest);
    return h?.state === "failed" ? h : undefined;
  });
  assert.match(host.error, /native stop enabled/);
  const record = readHost(path.join(fx.coordinationRoot, "dispatch-tab-close.json"));
  assert.equal(record?.stop, true);
  assert.equal(record?.scope, "workflow");
  const lists = fakeCalls(fx).filter((a) => a[0] === "list");
  assert.ok(lists.length >= 2, "absence needs two consecutive probes");
});

test("late ready stays ignored after failure; release and shutdown keep working", async (t) => {
  const fx = fixture("late-ready");
  const { child } = startBroker(fx);
  const exited = new Promise((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  t.after(async () => cleanup(fx, child));
  await waitFor(() => readHost(fx.manifest)?.port, 15000);
  const agentPeer = await connect(fx.manifest, "agent");
  agentPeer.events.on("message", (m) => {
    if (m.kind === "request" && m.op === "release")
      agentPeer.send({ kind: "reply", ok: true, id: m.id });
  });
  agentPeer.send({
    kind: "ready",
    session: { sessionId: "sess-1", sessionFile: "C:/tmp/sess.json" },
  });
  const failed = await waitFor(() => {
    const h = readHost(fx.manifest);
    return h?.state === "failed" ? h : undefined;
  });
  assert.match(failed.error, /native stop enabled/);
  // A late ready must not mark the failed host operational again.
  agentPeer.send({
    kind: "ready",
    session: { sessionId: "sess-1", sessionFile: "C:/tmp/sess.json" },
  });
  await delay(700);
  assert.equal(readHost(fx.manifest).state, "failed");
  const events = fs
    .readFileSync(path.join(fx.root, "broker-events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.ok(
    events.some((l) => l.includes("late-agent-message-ignored")),
    "late ready must be logged and ignored",
  );
  // Release and process cleanup stay possible in the failed state.
  const control = await connect(fx.manifest, "control");
  const release = await control.call("release", {});
  assert.equal(release, undefined);
  assert.equal(readHost(fx.manifest).executionReleased, true);
  assert.equal(readHost(fx.manifest).state, "failed");
  await control.call("shutdown");
  assert.equal(await exited, 0);
  agentPeer.close();
});

test("Orca connection error is unknown, not a close", async (t) => {
  const fx = fixture("orca-down");
  fs.writeFileSync(
    path.join(fx.dir, "scenario.json"),
    JSON.stringify({ statusError: true, terminalsByWorktree: {} }),
  );
  const { child } = startBroker(fx);
  t.after(async () => cleanup(fx, child));
  await waitFor(() => readHost(fx.manifest)?.port, 15000);
  const agentPeer = await connect(fx.manifest, "agent");
  t.after(() => agentPeer.close());
  agentPeer.send({
    kind: "ready",
    session: { sessionId: "sess-1", sessionFile: "C:/tmp/sess.json" },
  });
  await waitFor(() => readHost(fx.manifest)?.state === "ready");
  // Several probe cycles must pass without a close inference.
  await delay(3500);
  const host = readHost(fx.manifest);
  assert.notEqual(host.state, "failed");
  assert.equal(host.tabClose, undefined);
});

test("runtime restart with missing tab is unknown, not a close", async (t) => {
  const fx = fixture("runtime-restart");
  fs.writeFileSync(
    path.join(fx.dir, "scenario.json"),
    JSON.stringify({ runtimeId: "rt-2", terminalsByWorktree: {} }),
  );
  const { child } = startBroker(fx);
  t.after(async () => cleanup(fx, child));
  await waitFor(() => readHost(fx.manifest)?.port, 15000);
  const agentPeer = await connect(fx.manifest, "agent");
  t.after(() => agentPeer.close());
  agentPeer.send({
    kind: "ready",
    session: { sessionId: "sess-1", sessionFile: "C:/tmp/sess.json" },
  });
  await waitFor(() => readHost(fx.manifest)?.state === "ready");
  await delay(3500);
  const host = readHost(fx.manifest);
  assert.notEqual(host.state, "failed");
  assert.equal(host.tabClose, undefined);
});
