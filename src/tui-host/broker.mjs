/** Owns ConPTY independently of every Orca view and of the parent Pi process. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { atomicJson, readJson, jsonSocket, delay, VERSION } from "./protocol.mjs";
import { claimDispatchView } from "./dispatch-view.mjs";
import { agentDirectory } from '../pos/resources.mjs';
import {stopOnTabClose, tabPresence, requestTabStop, workspaceForView, createAbsenceTracker, isDispatchView} from './tab-close.mjs';

const root = path.resolve(process.argv[2]);
const manifestFile = path.join(root, "host.json");
const launch = readJson(path.join(root, "launch.json"));
if (!launch) throw Error("Missing TUI launch descriptor");
const mode = launch.execution;
const mapping = readJson(path.join(mode.coordinationRoot, "mapping.json"));
const settingsFile = mapping?.piBotsSettingsFile || path.join(mode.agentDir || agentDirectory(), 'settings.json');
if (!mapping?.exe) throw Error("Confirmed Orca workflow mapping is missing");
const token = randomUUID() + randomUUID();
let host = {
  version: VERSION,
  root,
  token,
  port: 0,
  pid: process.pid,
  state: "starting",
  createdAt: Date.now(),
  runId: launch.runtime.runId,
  index: launch.runtime.childIndex,
  agent: launch.runtime.agent,
  coordinationRoot: mode.coordinationRoot,
  view: null,
};
let agent,
  terminal,
  agentStarted = false,
  stopping = false;
let sequence = 0;
const absence = createAbsenceTracker(mapping.runtimeId);
const viewWorkspace = () => workspaceForView(host, mapping, launch.cwd);
const peers = new Set();
const operations = new Map();
let persistenceFailure = undefined;
// A recovered filesystem does not revive this broker. Native resume owns
// starting another execution; cleanup may still change the displayed state.
let failure;
const requireOperationalHost = () => {
  if (failure) throw failure;
};
const save = () => {
  try {
    atomicJson(manifestFile, { ...host, updatedAt: Date.now() });
    persistenceFailure = undefined;
    return true;
  } catch (error) {
    // A store failure is a terminal host failure, not a warning: no
    // ready/state/prompt/openView success signal may follow it. The original
    // error stays visible through the failure path below, which never calls
    // save() again (no recursive storage) and cannot be hidden by a log
    // failure. Release and cleanup keep working against the in-memory host.
    if (!persistenceFailure) persistenceFailure = error;
    if (host.state !== "failed") fail(error);
    return false;
  }
};
const broadcast = (message) => {
  const event = { ...message, sequence: ++sequence };
  // Live transport first: a broken or locked control-events file must not
  // keep the control peer from seeing the event (e.g. the original failure
  // error). The append is replay support only and stays best-effort.
  for (const p of peers) if (p.role === "control" && !p.paused) p.send(event);
  try {
    fs.appendFileSync(
      path.join(root, "control-events.jsonl"),
      JSON.stringify(event) + "\n",
    );
  } catch {}
};
const log = (kind, value) =>
  fs.appendFileSync(
    path.join(root, "broker-events.jsonl"),
    JSON.stringify({ at: Date.now(), kind, ...value }) + "\n",
  );
const fail = (error) => {
  if (failure) return;
  failure = error instanceof Error ? error : new Error(String(error));
  host.state = "failed";
  host.error = String(failure.stack || failure);
  // The original error must reach the control peer even when the host
  // store or the event log is broken: the transport comes first, and the
  // log/persist below are best-effort and never recurse into save().
  try {
    broadcast({ kind: "failed", error: host.error });
  } catch {}
  try {
    log("failed", { error: host.error });
  } catch {
    try {
      process.stderr.write(
        "TUI host failed (event log unavailable): " + host.error + "\n",
      );
    } catch {}
  }
  try {
    atomicJson(manifestFile, { ...host, updatedAt: Date.now() });
  } catch {
    // The on-disk state may lag behind the broadcast failure; the original
    // error is already visible above. No retry loop here.
  }
};

async function command(args) {
  return new Promise((resolve) => {
    const proc = spawn(mapping.exe, [...args, "--json"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    proc.stdout.on("data", (b) => (out += b));
    proc.stderr.on("data", (b) => (err += b));
    const timer = setTimeout(() => {
      proc.kill();
      resolve({
        ok: false,
        error: "Orca response pending; inspect the original operation.",
      });
    }, 40000);
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(error) });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out);
        resolve({ ok: code === 0 && result.ok !== false, data: result });
      } catch {
        resolve({ ok: false, error: err || out || "No Orca receipt" });
      }
    });
  });
}
let publication;
async function openView() {
  requireOperationalHost();
  if (host.tabClose?.stop) throw Error('This tab was closed with native stop enabled. Use the native resume path for further work.');
  if (publication) return publication;
  publication = (async () => {
    if ([...peers].some((p) => p.role === "view")) return host.view;
    if (host.dispatchView && !host.view && !host.previousViews?.length)
      host.view = { handle: mapping.worker.terminal.handle,
        tabId: mapping.worker.terminal.tabId, paneKey: mapping.worker.terminal.paneKey };
    if (host.view?.handle) {
      // Startup confirms exactly like the live monitor: two consecutive
      // confirmed absences in the tab's own workspace on the same reachable
      // Orca runtime. One unreadable answer is not a close.
      const started = Date.now();
      for (;;) {
        const presence = await probeViewPresence();
        if (presence === "found") return host.view;
        if (presence === "absent") break;
        if (Date.now() - started > 60000)
          throw Error(
            "Cannot reconcile the previous Orca tab: the Orca connection or inventory stayed unconfirmed for 60 seconds. No tab close was inferred.",
          );
        await delay(1000);
      }
      recordClosedView();
      if (host.tabClose.stop)
        throw Error('The original tab was closed with native stop enabled. Use native resume after the stop completes.');
      host.previousViews = [...(host.previousViews || []), host.view];
      host.view = null;
      host.viewState = "closed";
      if (!save()) throw persistenceFailure;
      if (host.dispatchView && !agentStarted)
        throw Error("The shared dispatch pane closed before Pi attached; native startup is blocked.");
    }
    if (host.viewState === "creating")
      throw Error(
        "Previous Orca tab creation has no confirmed outcome; replacement is blocked.",
      );
    host.viewState = "creating";
    host.viewRequestId = randomUUID();
    if (!save()) throw persistenceFailure;
    const entry = fileURLToPath(new URL("./attach.mjs", import.meta.url));
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const cmd = `& ${quote(process.execPath)} ${quote(entry)} ${quote(manifestFile)}`;
    const encoded = Buffer.from(cmd, "utf16le").toString("base64");
    const result = await command([
      "terminal",
      "create",
      "--worktree",
      `path:${launch.cwd}`,
      "--title",
      `Pi ${host.agent} · ${host.runId}:${host.index} [pt-${path.basename(root).slice(0, 8)}]`,
      "--command",
      `& ${quote(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))} -NoLogo -NoProfile -EncodedCommand ${encoded}`,
    ]);
    atomicJson(
      path.join(root, `view-receipt-${host.viewRequestId}.json`),
      result,
    );
    const view = result.data?.result?.terminal;
    if (view?.handle) {
      host.view = {
        handle: view.handle,
        tabId: view.tabId,
        paneKey: view.paneKey,
      };
      host.viewState = "created";
      if (!save()) throw persistenceFailure;
    } else if (!host.view)
      throw Error(
        "Orca tab creation is unconfirmed; no replacement was started. " +
          JSON.stringify(result),
      );
    return host.view;
  })().finally(() => (publication = undefined));
  return publication;
}
function startAgent(identity, cols, rows) {
  requireOperationalHost();
  if (agentStarted) return;
  agentStarted = true;
  host.state = "initializing";
  if (!save()) return;
  const env = { ...process.env, ...launch.processEnv };
  for (const key of Object.keys(env))
    if (key.startsWith("ORCA_") || key.startsWith("HERDR_")) delete env[key];
  Object.assign(env, identity);
  delete env.ORCA_PI_STATUS_OWNED;
  Object.assign(env, {
    PI_BOTS_TUI_HOST: manifestFile,
    PI_SUBAGENT_CHILD: "1",
    PI_OFFLINE: "1",
    JITI_ALIAS: launch.aliases,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete env[key];
  const entry = fileURLToPath(
    new URL("../../tui-agent-entry.mjs", import.meta.url),
  );
  try {
    terminal = pty.spawn(process.execPath, [entry, manifestFile], {
      name: "xterm-256color",
      cols: cols || 120,
      rows: rows || 40,
      cwd: launch.cwd,
      env,
      useConpty: true,
    });
    host.agentPid = terminal.pid;
    save();
    terminal.onData((data) => {
      fs.appendFileSync(path.join(root, "terminal.ansi"), data);
      for (const p of peers)
        if (p.role === "view") p.send({ kind: "output", data });
    });
    terminal.onExit((result) => {
      host.exitCode = result.exitCode;
      host.exitObservedAt = Date.now();
      host.state = stopping ? "retired" : "exited";
      save();
      broadcast({ kind: "exited", exitCode: result.exitCode });
      for (const [id, op] of operations)
        if (!op.reply)
          replyOperation(id, {
            ok: false,
            error: "Pi TUI process exited before this operation was confirmed.",
          });
      for (const p of peers)
        if (p.role === "view")
          p.send({
            kind: "notice",
            text: `Pi process ended (${result.exitCode}). Session: ${host.sessionFile || "unavailable"}`,
          });
    });
  } catch (error) {
    fail(error);
  }
}
function replyOperation(id, message) {
  const op = operations.get(id);
  if (!op) return;
  op.reply = { kind: "reply", id, ...message };
  atomicJson(path.join(root, "receipts", id + ".json"), {
    request: op.request,
    reply: op.reply,
  });
  for (const p of peers) if (p.role === "control") p.send(op.reply);
}
const server = net.createServer((socket) => {
  const peer = { socket, role: undefined, send: undefined };
  peers.add(peer);
  const timer = setTimeout(() => socket.destroy(), 5000);
  peer.send = jsonSocket(
    socket,
    async (message) => {
      try {
        if (!peer.role) {
          if (
            message.kind !== "hello" ||
            message.version !== VERSION ||
            message.token !== token ||
            !["control", "view", "agent"].includes(message.role)
          ) {
            socket.destroy();
            return;
          }
          clearTimeout(timer);
          if (message.role === "agent" && agent) {
            socket.destroy();
            return;
          }
          if (message.role === "view") {
            if (host.tabClose?.stop) throw Error('This child is stopping after its tab was closed.');
            host.tabClose = undefined;
            host.detachedAt = undefined;
            if (
              !message.identity?.ORCA_TERMINAL_HANDLE ||
              !message.identity?.ORCA_PANE_KEY
            )
              throw Error(
                "A TUI view must prove its own Orca terminal identity.",
              );
            for (const other of peers)
              if (other !== peer && other.role === "view") {
                other.send({
                  kind: "notice",
                  text: "TUI attached in another tab.",
                });
                other.socket.end();
              }
            host.view = {
              ...host.view,
              handle: message.identity.ORCA_TERMINAL_HANDLE,
              paneKey: message.identity.ORCA_PANE_KEY,
              tabId: message.identity.ORCA_TAB_ID,
            };
            host.viewState = "attached";
            host.identity = message.identity;
            save();
            const connectedView = host.view;
            void command(['status']).then(result => {
              if (host.view === connectedView && result.data?.result?.runtime?.reachable)
                absence.markObserved(result.data.result.runtime.runtimeId);
            });
          }
          peer.role = message.role;
          peer.paused = peer.role === "control";
          peer.send({
            kind: "hello",
            version: VERSION,
            host: {
              state: host.state,
              sessionId: host.sessionId,
              sessionFile: host.sessionFile,
            },
          });
          if (peer.role === "agent") agent = peer;
          if (peer.role === "view") {
            if (!agentStarted)
              startAgent(message.identity, message.cols, message.rows);
            else {
              terminal?.resize(message.cols || 120, message.rows || 40);
              agent?.send({
                kind: "request",
                id: "refresh-" + randomUUID(),
                op: "bindView",
                args: { identity: message.identity },
              });
            }
          }
          return;
        }
        if (peer.role === "view") {
          if (message.kind === "input" && typeof message.data === "string")
            terminal?.write(message.data);
          if (message.kind === "resize" && message.cols > 0 && message.rows > 0)
            terminal?.resize(
              Math.min(600, message.cols),
              Math.min(300, message.rows),
            );
          return;
        }
        if (peer.role === "agent") {
          if (
            (message.kind === "ready" || message.kind === "state") &&
            failure
          ) {
            // A terminal error stays terminal: a late ready/state message must
            // not mark the host operational again. Release and cleanup
            // operations keep working.
            log("late-agent-message-ignored", { ignored: message.kind });
            return;
          }
          if (message.kind === "ready") {
            Object.assign(host, message.session, { state: "ready" });
            if (!save()) return;
            broadcast(message);
          } else if (message.kind === "state") {
            Object.assign(host, message.state);
            if (!save()) return;
            broadcast(message);
          } else if (message.kind === "reply") {
            if (
              message.ok &&
              operations.get(message.id)?.request.op === "release"
            ) {
              host.executionReleased = true;
              save();
            }
            replyOperation(message.id, message);
          } else broadcast(message);
          return;
        }
        if (
          message.kind !== "request" ||
          typeof message.id !== "string" ||
          !/^[\w-]{1,160}$/.test(message.id)
        )
          throw Error("Invalid TUI request ID");
        const previous =
          operations.get(message.id) ||
          readJson(path.join(root, "receipts", message.id + ".json"));
        if (previous) {
          if (JSON.stringify(previous.request) !== JSON.stringify(message))
            throw Error("Conflicting original TUI request");
          if (previous.reply) peer.send(previous.reply);
          return;
        }
        operations.set(message.id, { request: message });
        atomicJson(path.join(root, "receipts", message.id + ".json"), {
          request: message,
          state: "pending",
        });
        if (message.op === "status")
          return replyOperation(message.id, {
            ok: true,
            result: { ...host, token: undefined, identity: undefined },
          });
        if (message.op === "diagnosticDropControl") {
          replyOperation(message.id, {
            ok: true,
            result: { originalAgentPid: host.agentPid },
          });
          setTimeout(() => {
            for (const p of peers) if (p.role === "control") p.socket.destroy();
          }, 30);
          return;
        }
        if (message.op === "replay") {
          const file = path.join(root, "control-events.jsonl");
          for (const line of fs.existsSync(file)
            ? fs.readFileSync(file, "utf8").split("\n")
            : []) {
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.sequence > (message.args?.after || 0)) peer.send(event);
          }
          peer.paused = false;
          return replyOperation(message.id, { ok: true, result: { sequence } });
        }
        if (message.op === "openView") {
          try {
            return replyOperation(message.id, {
              ok: true,
              result: await openView(),
            });
          } catch (error) {
            return replyOperation(message.id, {
              ok: false,
              error: String(error),
            });
          }
        }
        if (message.op === "shutdown") {
          if (host.state === "running")
            return replyOperation(message.id, {
              ok: false,
              error:
                "Stop the active native child before shutting down its TUI host.",
            });
          stopping = true;
          terminal?.kill();
          replyOperation(message.id, { ok: true, result: { stopped: true } });
          setTimeout(() => process.exit(0), 200);
          return;
        }
        // Inspection and native cleanup remain available, but no new work
        // may reach the old agent after a terminal failure, even if a later
        // manifest write could succeed.
        if (failure && !["snapshot", "abort", "release", "retire"].includes(message.op))
          return replyOperation(message.id, {
            ok: false,
            error: `TUI host is terminally failed: ${failure.message}`,
          });
        if (!agent)
          return replyOperation(message.id, {
            ok: false,
            error: "Pi TUI session is not ready.",
          });
        if (message.op === "retire") stopping = true;
        if (message.op === "prompt") {
          host.state = "running";
          if (!save())
            return replyOperation(message.id, {
              ok: false,
              error:
                "Prompt not accepted: TUI host persistence failed; the host is terminally failed (see the failed event with the original error).",
            });
        }
        agent.send(message);
      } catch (error) {
        log("protocol-error", { error: String(error) });
        if (message.id)
          replyOperation(message.id, { ok: false, error: String(error) });
        else socket.destroy();
      }
    },
    (error) => log("socket-error", { error: String(error) }),
  );
  socket.on("close", () => {
    clearTimeout(timer);
    peers.delete(peer);
    if (peer === agent) agent = undefined;
    if (peer.role === "view" && host.viewState === "attached" && ![...peers].some(p => p.role === 'view')) {
      host.viewState = "detached";
      host.detachedAt = Date.now();
      save();
    }
  });
});
let closeCheckBusy = false;
async function probeViewPresence() {
  // Shared by startup and live monitoring. Returns 'found' (host.view
  // updated), 'absent' (two consecutive confirmed absences), or 'unconfirmed'
  // (present-but-not-matched is handled above; connection errors, runtime
  // switches and unreadable inventories must never prove a close).
  const runtime = await command(['status']);
  if (!runtime.ok || runtime.data?.result?.runtime?.reachable !== true) {
    absence.probe('unknown');
    return 'unconfirmed';
  }
  const listed = await command(['terminal','list','--worktree',`path:${viewWorkspace()}`]);
  if (!listed.ok || !Array.isArray(listed.data?.result?.terminals)) {
    absence.probe('unknown');
    return 'unconfirmed';
  }
  const terminals = listed.data.result.terminals.map((t) => ({
    ...t,
    paneKey:
      t.paneKey ||
      (t.tabId && t.leafId ? `${t.tabId}:${t.leafId}` : undefined),
  }));
  const matches = terminals.filter(
    (t) =>
      t.handle === host.view.handle ||
      (host.view.paneKey &&
        host.view.tabId &&
        t.paneKey === host.view.paneKey &&
        t.tabId === host.view.tabId),
  );
  if (matches.length > 1)
    throw Error(
      "Orca returned ambiguous identities for the original child tab.",
    );
  if (matches.length === 1) {
    host.view = {
      handle: matches[0].handle,
      tabId: matches[0].tabId,
      paneKey: matches[0].paneKey,
    };
    if (host.dispatchView && !host.dispatchViewRenamed) {
      const renamed = await command(["terminal", "rename", "--terminal", host.view.handle,
        "--title", `Pi ${host.agent} · Dispatch · ${host.runId.slice(0, 8)}`]);
      host.dispatchViewRenamed = renamed.ok;
    }
    absence.probe('present', runtime.data.result.runtime.runtimeId);
    if (!save()) throw persistenceFailure;
    return 'found';
  }
  const presence = tabPresence(
    runtime.data.result.runtime,
    listed.data.result,
    host.view,
    absence.runtime(),
  );
  return absence.probe(presence) === 'absent' ? 'absent' : 'unconfirmed';
}
function recordClosedView() {
  if (host.tabClose) return;
  host.tabClose = {requestId:'tab-close-'+randomUUID(), confirmedAt:Date.now(),
    stop:stopOnTabClose(settingsFile), scope:isDispatchView(host, mapping) ? 'workflow' : 'child'};
  host.viewState = 'closed';
  host.detachedAt ||= Date.now();
  save();
  if (host.tabClose.scope === 'workflow')
    atomicJson(path.join(host.coordinationRoot,'dispatch-tab-close.json'),{...host.tabClose,view:host.view});
  log('tab-closed', host.tabClose);
}
async function checkTabClose() {
  if (closeCheckBusy || !host.view || !host.detachedAt || [...peers].some(p => p.role === 'view')) return;
  closeCheckBusy = true;
  try {
    if (!host.tabClose) {
      if (Date.now() - host.detachedAt < 1500) return;
      if ((await probeViewPresence()) !== 'absent') return;
      recordClosedView();
    }
    if (!host.tabClose.stop) return;
    if (!host.tabClose.requests) {
      host.tabClose.requests = requestTabStop(host);
      save();
    }
    for (const request of host.tabClose.requests) {
      const reply = readJson(request.file + '.reply.json');
      if (reply?.success === false) throw Error('Original native tab-close stop failed: ' + JSON.stringify(reply.error));
    }
    host.tabCloseError = undefined;
    // The native runner owns cancellation and status. Only retire the UI after
    // it has released its child; killing Pi first would turn Stop into a crash.
    if ((host.executionReleased || host.exitObservedAt) && !host.tabClose.retiringAt) {
      host.tabClose.retiringAt = Date.now();
      stopping = true;
      save();
      if (!host.exitObservedAt && agent) agent.send({kind:'request',id:'tab-close-retire-'+randomUUID(),op:'retire',args:{}});
    }
    if (host.exitObservedAt) {
      host.tabClose.completedAt = Date.now();
      save();
      setTimeout(() => process.exit(0), 200);
    }
  } catch (error) {
    host.tabCloseError = String(error.message || error);
    save();
  } finally { closeCheckBusy = false; }
}
setInterval(checkTabClose, 1000).unref();
server.listen(0, "127.0.0.1", async () => {
  host.port = server.address().port;
  if (!save()) return;
  try {
    host.dispatchView = await claimDispatchView(mode.coordinationRoot, manifestFile, launch);
    if (!save()) throw persistenceFailure;
    await openView();
  } catch (error) {
    fail(error);
  }
});
process.on("uncaughtException", (error) => fail(error));
process.on("unhandledRejection", (error) => fail(error));
