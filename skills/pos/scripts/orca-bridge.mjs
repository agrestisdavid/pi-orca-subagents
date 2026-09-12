import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicJson, command, ensureBoundAdapter } from "./orca-adapter.mjs";
import { bindParentCoordinator } from './parent-coordinator.mjs';

export const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
export const keyFor = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);
export const terminalPaneKey = (t) =>
  t?.paneKey || (t?.tabId && t?.leafId ? `${t.tabId}:${t.leafId}` : undefined);
export function orcaExecutable() {
  const exe =
    process.env.ORCA_CLI_COMMAND ||
    path.join(
      process.env.LOCALAPPDATA || "",
      "Programs/orca/resources/bin/orca.exe",
    );
  if (!path.isAbsolute(exe) || !fs.existsSync(exe))
    throw Error(`Orca executable unavailable: ${exe}`);
  return exe;
}
function resultOf(reply) {
  if (!reply?.ok || reply.data?.ok === false)
    throw Error(
      reply?.data?.error?.message ||
        reply?.error ||
        reply?.stderr ||
        "Orca did not acknowledge command",
    );
  return reply.data?.result || reply.data;
}
async function cli(exe, args) {
  return resultOf(await command(exe, [...args, "--json"]));
}
export async function queuedCommand(dir, id, args, { waitMs = 35000 } = {}) {
  const input = path.join(dir, `cmd-${id}.json`),
    output = path.join(dir, `reply-${id}.json`);
  const request = { args: ["orchestration", ...args, "--json"] };
  const existing = readJson(input);
  if (
    existing &&
    JSON.stringify(existing.args) !== JSON.stringify(request.args)
  )
    throw Error(`Conflicting original adapter operation ${id}`);
  if (!existing) atomicJson(input, request);
  const until = Date.now() + waitMs;
  do {
    const reply = readJson(output);
    if (reply) return reply;
    if (Date.now() >= until)
      throw Error(
        `Orca adapter ${id}: response pending; original command retained at ${input}. No replacement was issued.`,
      );
    await new Promise((r) => setTimeout(r, 200));
  } while (true);
}
async function endpoint(root, role, cwd, exe, sharedTui = false) {
  const dir = path.join(root, role);
  fs.mkdirSync(dir, { recursive: true });
  const recordFile = path.join(dir, "terminal.json"),
    claim = path.join(dir, "terminal.claim");
  let terminal = readJson(recordFile);
  if (!terminal && !fs.existsSync(claim)) {
    fs.writeFileSync(
      claim,
      JSON.stringify({ cwd, role, createdAt: Date.now() }),
      { flag: "wx" },
    );
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const adapter = fileURLToPath(
      new URL("./orca-adapter.mjs", import.meta.url),
    );
    const ps = `& ${quote(process.execPath)} ${quote(adapter)} ${quote(dir)} ${quote(exe)}${sharedTui ? " --shared-tui" : ""}`;
    const launch = `& ${quote(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))} -NoLogo -NoProfile -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`;
    const result = await command(exe, [
      "terminal",
      "create",
      "--worktree",
      `path:${cwd}`,
      "--title",
      `POS ${role === 'workflow' ? 'Dispatch' : 'Coordinator'} [${path.basename(root).slice(0, 12)}]`,
      "--command",
      launch,
      "--json",
    ]);
    atomicJson(path.join(dir, "terminal-result.json"), result);
    if (result.ok) {
      terminal = resultOf(result).terminal;
      atomicJson(recordFile, terminal);
    }
  }
  let hello;
  for (let n = 0; n < 100; n++) {
    hello = readJson(path.join(dir, "hello.json"));
    if (hello) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!terminal && hello) {
    const listed = await cli(exe, [
      "terminal",
      "list",
      "--worktree",
      `path:${cwd}`,
    ]);
    const matches = (listed.terminals || [])
      .map((t) => ({ ...t, paneKey: terminalPaneKey(t) }))
      .filter(
        (t) =>
          t.handle === hello.identity.ORCA_TERMINAL_HANDLE &&
          t.paneKey === hello.identity.ORCA_PANE_KEY,
      );
    if (matches.length === 1) {
      terminal = matches[0];
      atomicJson(recordFile, terminal);
    }
  }
  if (
    !terminal ||
    !hello ||
    terminal.handle !== hello.identity.ORCA_TERMINAL_HANDLE ||
    terminal.paneKey !== hello.identity.ORCA_PANE_KEY
  )
    throw Error(
      `Owned ${role} terminal identity unconfirmed. Inspect ${dir}; automatic replacement is blocked.`,
    );
  return { dir, terminal, identity: hello.identity, ownedTerminal: true };
}

export async function prepareWorkflow(root, cwd, launch, options = {}) {
  fs.mkdirSync(root, { recursive: true });
  const exe = orcaExecutable();
  const runtimeStatus = await cli(exe, ["status"]);
  if (runtimeStatus.runtime?.reachable !== true)
    throw Error(
      `Orca runtime is unavailable (${runtimeStatus.runtime?.state || "unknown"}); no native workflow was started.`,
    );
  const wt = await cli(exe, ["worktree", "show", "--worktree", `path:${cwd}`]);
  if (
    path.resolve(wt.worktree.path).toLowerCase() !==
    path.resolve(cwd).toLowerCase()
  )
    throw Error("Orca did not resolve the exact workflow directory");
  // Reuse the actual invoking parent, never an arbitrary focused terminal.
  // A parent launched outside Orca still needs its own coordination endpoint.
  const coordinator = await bindParentCoordinator(root, exe) || await endpoint(root, "coordinator", cwd, exe);
  const worker = await endpoint(root, "workflow", cwd, exe, options.tuiViewPolicy === "dispatch-first");
  const spec =
    typeof launch.task === "string"
      ? launch.task
      : typeof launch.workflowScript === "string"
        ? launch.workflowScript
        : JSON.stringify(launch);
  const run = resultOf(
    await queuedCommand(coordinator.dir, "run", [
      "run-create",
      "--objective",
      spec,
    ]),
  ).run;
  const task = resultOf(
    await queuedCommand(coordinator.dir, "task", [
      "task-create",
      "--spec",
      spec,
      "--run",
      run.id,
    ]),
  ).task;
  const dispatched = resultOf(
    await queuedCommand(coordinator.dir, "dispatch", [
      "dispatch",
      "--task",
      task.id,
      "--to",
      worker.terminal.handle,
      "--run",
      run.id,
      "--return-preamble",
    ]),
  );
  const d = dispatched.dispatch;
  if (
    d.task_id !== task.id ||
    d.run_id !== run.id ||
    d.assignee_handle !== worker.terminal.handle ||
    d.assignee_pane_key !== worker.terminal.paneKey ||
    typeof dispatched.preamble !== "string"
  )
    throw Error("Orca dispatch identity or preamble was not confirmed");
  fs.writeFileSync(path.join(root, "preamble.txt"), dispatched.preamble);
  const proof = resultOf(
    await queuedCommand(coordinator.dir, "proof", [
      "dispatch-show",
      "--task",
      task.id,
    ]),
  ).dispatch;
  if (proof.id !== d.id || proof.status !== "dispatched")
    throw Error("Dispatch proof did not confirm the assigned active workflow");
  const link = {
    version: 1,
    root,
    ...(options.tuiViewPolicy ? { tuiViewPolicy: options.tuiViewPolicy } : {}),
    ...(options.piBotsSettingsFile ? {piBotsSettingsFile:options.piBotsSettingsFile} : {}),
    runtimeId: runtimeStatus.runtime.runtimeId,
    cwd,
    exe,
    coordinator,
    worker,
    orcaRunId: run.id,
    taskId: task.id,
    dispatchId: d.id,
    nativeRuns: [],
    questions: {},
    state: "dispatched",
    updatedAt: Date.now(),
  };
  atomicJson(path.join(root, "mapping.json"), link);
  return link;
}
export function attachNative(root, location, supervisorRoot) {
  const file = path.join(root, "native-link.json"),
    link = readJson(file) || { runs: [], supervisorRoot };
  if (!link.runs.some((r) => r.runId === location.runId))
    link.runs.push(location);
  link.current = location;
  link.supervisorRoot = supervisorRoot;
  atomicJson(file, link);
  const mapping = readJson(path.join(root, "mapping.json"));
  mapping.nativeRuns = link.runs;
  mapping.state = "running";
  atomicJson(path.join(root, "mapping.json"), mapping);
}
export function confirmNativeReply(root, requestId, message) {
  atomicJson(path.join(root, "answers", `${keyFor(requestId)}.json`), {
    requestId,
    message,
    confirmedBy: "subagent_supervisor",
    confirmedAt: Date.now(),
  });
}
export function captureNativeQuestion(root, request) {
  const { _channelDir, _requestFile, ...publicRequest } = request;
  atomicJson(
    path.join(root, "questions", `${keyFor(request.id)}.json`),
    publicRequest,
  );
}
export async function failBeforeNative(root, error) {
  const mapping = readJson(path.join(root, "mapping.json"));
  if (!mapping) return;
  atomicJson(path.join(root, "launch-failed.json"), { error });
}
export function bridgeStatus(root) {
  const mapping = readJson(path.join(root, "mapping.json")),
    health = readJson(path.join(root, "health.json"));
  const closed = readJson(path.join(root, 'dispatch-tab-close.json'));
  if (closed && !health?.done) return {...mapping,tabClose:closed,health:{...health,connected:false,
    error:closed.stop ? 'The shared dispatch tab was closed. Native workflow stop was requested; inspect native status for completion.' : 'The shared dispatch tab was closed. Its Orca dispatch is cancelled; native execution continues because stopOnTabClose is disabled.'}};
  if (!health && mapping?.updatedAt && Date.now() - mapping.updatedAt < 60000)
    return {
      ...mapping,
      health: {
        connected: true,
        initializing: true,
        updatedAt: mapping.updatedAt,
      },
    };
  const stale =
    !health?.done &&
    (!health?.updatedAt || Date.now() - health.updatedAt > 60000);
  return {
    ...mapping,
    health: stale
      ? {
          ...health,
          connected: false,
          error:
            "Workflow adapter has not reported within 60 seconds; native Pi continues independently.",
        }
      : health,
  };
}

// Only reconnect original panes. A new actor is not a substitute for the
// coordinator/assignee of an existing dispatch.
export async function recoverWorkflowAdapters(root) {
  const map = readJson(path.join(root, "mapping.json"));
  if (!map) return;
  const listed = await cli(map.exe, [
    "terminal",
    "list",
  ]);
  for (const endpoint of [map.coordinator, map.worker]) {
    const matches = (listed.terminals || [])
      .map((t) => ({ ...t, paneKey: terminalPaneKey(t) }))
      .filter(
        (t) =>
          t.paneKey === endpoint.terminal.paneKey &&
          t.tabId === endpoint.terminal.tabId,
      );
    if (matches.length !== 1)
      throw Error(
        `Original Orca ${path.basename(endpoint.dir)} pane is unavailable. Stable dispatch actor restoration is required; no replacement dispatch was created.`,
      );
    const terminal = matches[0],
      hello = readJson(path.join(endpoint.dir, "hello.json"));
    let live = false;
    if (hello?.pid)
      try {
        process.kill(hello.pid, 0);
        live = true;
      } catch {}
    if (
      live &&
      hello?.version === 2 &&
      hello.identity?.ORCA_TERMINAL_HANDLE === terminal.handle &&
      Date.now() - hello.updatedAt < 10000
    )
      continue;
    if (hello?.version !== 2 && hello?.pid) {
      try {
        process.kill(hello.pid, 0);
        continue;
      } catch {}
    }
    const claim = path.join(
      endpoint.dir,
      "rebind-" +
        keyFor(terminal.handle + ":" + hello?.pid + ":" + hello?.bindingId) +
        ".claim",
    );
    if (fs.existsSync(claim))
      throw Error(
        "Original adapter rebind is awaiting its acknowledgement; duplicate terminal input blocked.",
      );
    fs.writeFileSync(
      claim,
      JSON.stringify({ at: Date.now(), handle: terminal.handle }),
      { flag: "wx" },
    );
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const script = fileURLToPath(
      new URL("./orca-adapter.mjs", import.meta.url),
    );
    const launch = `& ${quote(process.execPath)} ${quote(script)} ${quote(endpoint.dir)} ${quote(map.exe)}`;
    if (endpoint.ownedTerminal === false || map.tuiViewPolicy === "dispatch-first" && endpoint.dir === map.worker.dir) {
      // Parent and shared child panes contain Pi input. Rebind the independent
      // adapter from its verified identity; never type shell code into Pi.
      const previous = readJson(path.join(endpoint.dir, "binding.json"));
      if (previous?.identity?.ORCA_PANE_KEY !== terminal.paneKey ||
          previous?.identity?.ORCA_TAB_ID !== terminal.tabId)
        throw Error("Original adapter identity mismatch; restart blocked.");
      const identity = { ...previous.identity, ORCA_TERMINAL_HANDLE: terminal.handle };
      atomicJson(path.join(endpoint.dir, "binding.json"), {
        ...previous, id: randomUUID(), identity, env: { ...previous.env, ...identity },
      });
      ensureBoundAdapter(endpoint.dir, map.exe);
    } else {
      await cli(map.exe, [
        "terminal", "send", "--terminal", terminal.handle,
        "--text", launch, "--enter",
      ]);
    }
    const deadline = Date.now() + 20000;
    let acknowledgement;
    while (Date.now() < deadline) {
      const current = readJson(path.join(endpoint.dir, "hello.json"));
      if (
        current?.version === 2 &&
        current.pid !== hello?.pid &&
        current.identity.ORCA_TERMINAL_HANDLE === terminal.handle &&
        Date.now() - current.updatedAt < 10000
      ) {
        acknowledgement = current;
        break;
      }
      if (
        current?.version === 2 &&
        current.bindingId !== hello?.bindingId &&
        current.identity.ORCA_TERMINAL_HANDLE === terminal.handle &&
        Date.now() - current.updatedAt < 10000
      ) {
        acknowledgement = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!acknowledgement)
      throw Error(
        "Original adapter rebind has no confirmed receipt; replacement remains blocked.",
      );
    endpoint.terminal = terminal;
    endpoint.identity = acknowledgement.identity;
  }
  atomicJson(path.join(root, "mapping.json"), map);
}
