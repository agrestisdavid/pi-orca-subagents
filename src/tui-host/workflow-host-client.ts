/** Durable model-free owner of the upstream in-process workflow executor. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicJson, readJson, delay } from "./protocol.mjs";
import { TEMP_ROOT_DIR } from "../shared/types.ts";
import {
  resolvePiPackageRoot,
  resolveInstalledPiPackageRoot,
} from "../runs/shared/pi-spawn.ts";
import { resolveHostPeerAliases } from "../runs/background/runner-aliases.ts";
import { currentCompletionOwnerId } from "../shared/completion-owner.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function controlIndexFile(sessionId: string, runId: string) {
  return path.join(
    TEMP_ROOT_DIR,
    "tui-workflow-controls",
    hash(sessionId),
    hash(runId) + ".json",
  );
}
export function registerWorkflowControl(
  root: string,
  sessionId: string,
  runId: string,
) {
  atomicJson(controlIndexFile(sessionId, runId), {
    version: 1,
    root,
    sessionId,
    runId,
  });
}
export function workflowControlRoot(
  sessionId: string,
  runId: string,
): string | undefined {
  const current = readJson(controlIndexFile(sessionId, runId));
  if (current) return current.root;
  // Migrate a pre-release host indexed with the Pi UUID, only after checking
  // that its descriptor names this exact original parent session file.
  if (path.isAbsolute(sessionId) && fs.existsSync(sessionId)) {
    try {
      const header = JSON.parse(
        fs.readFileSync(sessionId, "utf8").split("\n")[0],
      );
      const old = readJson(controlIndexFile(header.id, runId));
      if (
        old &&
        readJson(path.join(old.root, "launch.json"))?.parentSessionFile ===
          sessionId
      )
        return old.root;
    } catch {}
  }
}
export async function callWorkflowHost(root: string, request: any) {
  const manifest = readJson(path.join(root, "host.json"));
  if (manifest?.version !== 1)
    throw Error(
      "Native workflow host identity is unconfirmed; replacement blocked.",
    );
  const file = path.join(root, "commands", hash(request.requestId) + ".json"),
    previous = readJson(file);
  if (previous && JSON.stringify(previous) !== JSON.stringify(request))
    throw Error("Conflicting original workflow control request.");
  if (!previous) atomicJson(file, request);
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const reply = readJson(file + ".reply.json");
    if (reply) {
      if (!reply.success)
        throw Error(
          reply.error?.message ||
            reply.error ||
            "Native workflow request failed",
        );
      return reply.data;
    }
    await delay(100);
  }
  throw Object.assign(
    Error(
      `Native workflow response remains pending (${request.requestId}) at ${root}. No replacement was started.`,
    ),
    { uncertain: true },
  );
}
export async function startWorkflowHost(request: any, ctx: any) {
  const root = path.join(
    request.params.childExecution.coordinationRoot,
    "native-workflow-host",
  );
  fs.mkdirSync(root, { recursive: true });
  const sessionId = resolveCurrentSessionId(ctx.sessionManager);
  if (!fs.existsSync(path.join(root, "start.claim"))) {
    const packageRoot =
      resolvePiPackageRoot() ?? resolveInstalledPiPackageRoot();
    if (!packageRoot)
      throw Error(
        "Pi SDK package root unavailable for the native workflow host.",
      );
    const aliases = resolveHostPeerAliases(packageRoot);
    if (aliases.missing.length)
      throw Error("Missing Pi host peers: " + aliases.missing.join(", "));
    fs.writeFileSync(
      path.join(root, "start.claim"),
      JSON.stringify({ requestId: request.requestId, at: Date.now() }),
      { flag: "wx" },
    );
    const snapshot = path.join(root, "parent-context.jsonl");
    fs.writeFileSync(
      snapshot,
      [ctx.sessionManager.getHeader(), ...ctx.sessionManager.getEntries()]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    atomicJson(path.join(root, "launch.json"), {
      version: 1,
      root,
      sessionId,
      cwd: ctx.cwd,
      sessionFile: snapshot,
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      packageRoot,
      completionOwnerId: currentCompletionOwnerId(),
      execution: request.params.childExecution,
    });
    const entry = fileURLToPath(
      new URL("../../workflow-host-entry.mjs", import.meta.url),
    );
    const log = fs.openSync(path.join(root, "host.log"), "a");
    const env = {
      ...process.env,
      JITI_ALIAS: JSON.stringify(aliases.aliases),
      PI_BOTS_WORKFLOW_HOST: root,
    };
    for (const key of Object.keys(env))
      if (key.startsWith("ORCA_") || key.startsWith("HERDR_")) delete env[key];
    const proc = spawn(process.execPath, [entry, root], {
      cwd: ctx.cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    proc.unref();
    fs.closeSync(log);
    atomicJson(path.join(root, "process.json"), {
      pid: proc.pid,
      requestId: request.requestId,
      at: Date.now(),
    });
  }
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const host = readJson(path.join(root, "host.json"));
    if (host?.state === "ready") break;
    if (host?.state === "failed") throw Error(host.error);
    await delay(100);
  }
  const data = await callWorkflowHost(root, {
    ...request,
    requestId: request.requestId + "-owned",
  });
  const runId = data?.details?.runId || data?.details?.asyncId;
  if (runId) registerWorkflowControl(root, sessionId, runId);
  return data;
}

/** Read an owned execution receipt after the parent died before forwarding it. */
export function recoverWorkflowStartReply(request: any, sessionId: string) {
  if (
    request?.method !== "spawn" ||
    !request.params?.workflowScript ||
    !request.params?.childExecution
  )
    return;
  const root = path.join(
    request.params.childExecution.coordinationRoot,
    "native-workflow-host",
  );
  const launch = readJson(path.join(root, "launch.json"));
  const claim = readJson(path.join(root, "start.claim"));
  if (launch?.sessionId !== sessionId || claim?.requestId !== request.requestId)
    return;
  const ownedId = request.requestId + "-owned";
  const reply = readJson(
    path.join(root, "commands", hash(ownedId) + ".json.reply.json"),
  );
  if (reply?.requestId !== ownedId || reply.method !== "spawn") return;
  const runId = reply.data?.details?.runId || reply.data?.details?.asyncId;
  if (runId) registerWorkflowControl(root, sessionId, runId);
  return { ...reply, requestId: request.requestId };
}
