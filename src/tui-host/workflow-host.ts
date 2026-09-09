import * as fs from "node:fs";
import * as path from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { readJson, atomicJson } from "./protocol.mjs";
import { setChildSessionFactory } from "../runs/shared/child-session.ts";
import { createTuiChildSessionFactory } from "./factory.ts";
import { currentChildExecution } from "../api/child-execution.ts";
import { registerWorkflowControl } from "./workflow-host-client.ts";
import { DIRS } from "../shared/types.ts";
import { setWorkflowHostSessionIdentity } from "../shared/session-identity.ts";
const root = process.argv[2],
  config = readJson(path.join(root, "launch.json"));
(globalThis as any)[Symbol.for("pi-subagents.completion-owner-id")] =
  config.completionOwnerId;
setWorkflowHostSessionIdentity(config.sessionId);
const factories = new Map<string, any>();
setChildSessionFactory({
  async create(launch) {
    const runId = launch.runtime.runId;
    if (!runId) throw Error("Native workflow child identity missing");
    registerWorkflowControl(root, config.sessionId, runId);
    const mode = currentChildExecution() ?? config.execution;
    const key = runId + mode.coordinationRoot;
    let factory = factories.get(key);
    if (!factory) {
      factory = createTuiChildSessionFactory({
        childExecution: mode,
        asyncDir: path.join(DIRS.async, runId),
        piPackageRoot: config.packageRoot,
      });
      factories.set(key, factory);
    }
    return factory.create(launch);
  },
  async dispose() {
    for (const factory of factories.values()) await factory.dispose();
  },
});
let api: any;
const native = (await import("../../index.ts")).default;
const bridge = {
  name: "pi-bots:native-workflow-owner",
  factory(extension: any) {
    api = extension;
    // This is the upstream workflow runner, with no coordinator model loop.
    native({
      ...extension,
      sendMessage(message: any, options: any) {
        extension.sendMessage(message, { ...options, triggerTurn: false });
      },
      sendUserMessage() {
        throw Error(
          "Model-free workflow owner cannot start an assistant turn.",
        );
      },
    });
  },
};
const agentDir = path.dirname(config.execution.statusExtension);
const settingsManager = pi.SettingsManager.create(
  config.cwd,
  path.dirname(agentDir),
);
const modelRuntime = await pi.ModelRuntime.create();
const loader = new pi.DefaultResourceLoader({
  cwd: config.cwd,
  agentDir: path.dirname(agentDir),
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  extensionFactories: [bridge],
});
await loader.reload();
const resolved = config.model
  ? pi.resolveCliModel({ cliModel: config.model, modelRuntime })
  : undefined;
const { session } = await pi.createAgentSession({
  cwd: config.cwd,
  agentDir: path.dirname(agentDir),
  settingsManager,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: pi.SessionManager.open(
    config.sessionFile,
    undefined,
    config.cwd,
  ),
  ...(resolved?.model ? { model: resolved.model } : {}),
  sessionStartEvent: { type: "session_start", reason: "startup" },
});
// A custom workflow host may manage children but must never run its own model.
(session as any).prompt = async () => {
  throw Error("No model loop is permitted in the Pi Bots workflow owner.");
};
(session as any).agent.prompt = async () => {
  throw Error("No model loop is permitted in the Pi Bots workflow owner.");
};
await session.bindExtensions({
  mode: "print",
  onError: (error: any) => console.error(error),
});
fs.mkdirSync(path.join(root, "commands"), { recursive: true });
atomicJson(path.join(root, "host.json"), {
  version: 1,
  state: "ready",
  pid: process.pid,
  sessionId: config.sessionId,
  createdAt: Date.now(),
});
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    for (const name of fs
      .readdirSync(path.join(root, "commands"))
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
      const file = path.join(root, "commands", name);
      if (
        fs.existsSync(file + ".reply.json") ||
        fs.existsSync(file + ".pending")
      )
        continue;
      fs.writeFileSync(file + ".pending", String(Date.now()), { flag: "wx" });
      const request = readJson(file);
      const reply: any = await new Promise((resolve) => {
        const off = api.events.on(
          "subagents:rpc:v1:reply:" + request.requestId,
          (value: any) => {
            off();
            resolve(value);
          },
        );
        api.events.emit("subagents:rpc:v1:request", request);
      });
      const id = reply.data?.details?.runId || reply.data?.details?.asyncId;
      if (id) registerWorkflowControl(root, config.sessionId, id);
      atomicJson(file + ".reply.json", reply);
    }
  } catch (error) {
    console.error(error);
  } finally {
    busy = false;
  }
}, 100);
