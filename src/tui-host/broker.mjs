/** Owns ConPTY independently of every Orca view and of the parent Pi process. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { atomicJson, readJson, jsonSocket, VERSION } from "./protocol.mjs";

const root = path.resolve(process.argv[2]);
const manifestFile = path.join(root, "host.json");
const launch = readJson(path.join(root, "launch.json"));
if (!launch) throw Error("Missing TUI launch descriptor");
const mode = launch.execution;
const mapping = readJson(path.join(mode.coordinationRoot, "mapping.json"));
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
const peers = new Set();
const operations = new Map();
const save = () => atomicJson(manifestFile, { ...host, updatedAt: Date.now() });
const broadcast = (message) => {
  const event = { ...message, sequence: ++sequence };
  fs.appendFileSync(
    path.join(root, "control-events.jsonl"),
    JSON.stringify(event) + "\n",
  );
  for (const p of peers) if (p.role === "control" && !p.paused) p.send(event);
};
const log = (kind, value) =>
  fs.appendFileSync(
    path.join(root, "broker-events.jsonl"),
    JSON.stringify({ at: Date.now(), kind, ...value }) + "\n",
  );
const fail = (error) => {
  host.state = "failed";
  host.error = String(error?.stack || error);
  save();
  broadcast({ kind: "failed", error: host.error });
  log("failed", { error: host.error });
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
  if (publication) return publication;
  publication = (async () => {
    if ([...peers].some((p) => p.role === "view")) return host.view;
    if (host.view?.handle) {
      const shown = await command([
        "terminal",
        "list",
        "--worktree",
        `path:${launch.cwd}`,
      ]);
      if (!shown.ok)
        throw Error(
          "Cannot reconcile the previous Orca tab: " + JSON.stringify(shown),
        );
      const matches = shown.data.result.terminals
        .map((t) => ({
          ...t,
          paneKey:
            t.paneKey ||
            (t.tabId && t.leafId ? `${t.tabId}:${t.leafId}` : undefined),
        }))
        .filter(
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
        save();
        return host.view;
      }
      host.previousViews = [...(host.previousViews || []), host.view];
      host.view = null;
      host.viewState = "closed";
      save();
    }
    if (host.viewState === "creating")
      throw Error(
        "Previous Orca tab creation has no confirmed outcome; replacement is blocked.",
      );
    host.viewState = "creating";
    host.viewRequestId = randomUUID();
    save();
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
      save();
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
  if (agentStarted) return;
  agentStarted = true;
  host.state = "initializing";
  save();
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
          if (message.kind === "ready") {
            Object.assign(host, message.session, { state: "ready" });
            save();
            broadcast(message);
          } else if (message.kind === "state") {
            Object.assign(host, message.state);
            save();
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
        if (!agent)
          return replyOperation(message.id, {
            ok: false,
            error: "Pi TUI session is not ready.",
          });
        if (message.op === "retire") stopping = true;
        if (message.op === "prompt") {
          host.state = "running";
          save();
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
    if (peer.role === "view" && host.viewState === "attached") {
      host.viewState = "detached";
      save();
    }
  });
});
server.listen(0, "127.0.0.1", async () => {
  host.port = server.address().port;
  save();
  try {
    await openView();
  } catch (error) {
    fail(error);
  }
});
process.on("uncaughtException", (error) => fail(error));
process.on("unhandledRejection", (error) => fail(error));
