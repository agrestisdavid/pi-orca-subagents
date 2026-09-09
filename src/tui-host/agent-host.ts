/** The single session owner: native Pi InteractiveMode plus native child hooks. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as pi from "@earendil-works/pi-coding-agent";
import { createTaskMutationArbiter } from "../runs/shared/llm-intent-arbiter.ts";
import { createDefaultChildSessionFactory } from "../runs/shared/child-session.ts";
import { createChildHooks } from "../runs/shared/child-hooks.ts";
import { setRunnerChildExecution } from "../api/child-execution.ts";
import { connect, readJson, atomicJson } from "./protocol.mjs";

const manifestFile = process.env.PI_BOTS_TUI_HOST!;
const descriptor = readJson(
  path.join(path.dirname(manifestFile), "launch.json"),
);
setRunnerChildExecution(descriptor.execution);
const channel = await connect(manifestFile, "agent");
let session: any,
  tui: any,
  child: any,
  resources: any,
  active = false,
  grant = false,
  nativeAbort = false;
let interrupted = false,
  closed = false,
  context: any;
let ownTodoPlan = false;
const uiRequests = new Map<string, string>();
const callbackSnapshot = new Map<string, any>();
const callback = (name: string, ...args: any[]) => {
  callbackSnapshot.set(name, { name, args });
  channel.send({ kind: "callback", name, args });
};
const runtime = {
  ...descriptor.runtime,
  toolDiagnostic: (value: any) => callback("toolDiagnostic", value),
  runtimeAcknowledgements: (ids: any) =>
    callback("runtimeAcknowledgements", ids),
  ...(descriptor.runtime.childWatchdog
    ? { watchdogStatus: (event: any) => callback("watchdogStatus", event) }
    : {}),
  ...(descriptor.runtime.structuredOutput
    ? {
        structuredOutput: {
          ...descriptor.runtime.structuredOutput,
          capture: (value: any, report: any) =>
            callback("structuredOutput", value, report),
        },
      }
    : {}),
};
const snapshot = () => ({
  sessionId: session.sessionId,
  sessionFile: session.sessionFile,
  modelId: session.model
    ? `${session.model.provider}/${session.model.id}`
    : undefined,
  messages: session.messages,
  callbacks: [...callbackSnapshot.values()],
});
function requestResume(message: string) {
  if (active)
    throw Error(
      "The native child is still active. Send a steering message or interrupt it first.",
    );
  if (!closed)
    throw Error(
      "The native attempt is still starting or settling. Wait for its confirmed result.",
    );
  if (!message.trim())
    throw Error("Provide a follow-up task after /bot-resume.");
  const id = "tui-" + randomUUID();
  const file = path.join(
    path.dirname(descriptor.execution.parentJournal),
    "tui-requests",
    id + ".json",
  );
  atomicJson(file, {
    version: 1,
    id,
    kind: "resume",
    runId: runtime.runId,
    index: runtime.childIndex,
    sessionFile: session.sessionFile,
    manifest: manifestFile,
    message,
    createdAt: Date.now(),
  });
  uiRequests.set(id, file);
  context.ui.notify(
    "Native resume requested. The parent will confirm the same session before continuing.",
    "info",
  );
}
const integration = {
  name: "pi-bots:tui-controls",
  factory(api: any) {
    api.on("tool_call", (event: any) => {
      if (!ownTodoPlan && event.toolName !== "todo")
        return {
          block: true,
          reason:
            "Create a short plan for this child with todo before starting the assigned work.",
        };
      if (
        !ownTodoPlan &&
        event.toolName === "todo" &&
        event.input?.action === "update"
      )
        return {
          block: true,
          reason:
            "Create this child's own todo item first; inherited tasks are not its plan.",
        };
    });
    api.on("tool_result", (event: any) => {
      if (event.toolName !== "todo" || event.isError) return;
      if (event.input?.action === "create") ownTodoPlan = true;
      if (event.input?.action === "clear") ownTodoPlan = false;
    });
    api.on("session_start", (_event: any, ctx: any) => {
      context = ctx;
      ctx.ui.setStatus(
        "pi-bots",
        `Pi Bots · ${runtime.agent} · ${runtime.runId}:${runtime.childIndex}`,
      );
    });
    api.on("session_before_switch", () => ({ cancel: true }));
    api.on("session_before_fork", () => ({ cancel: true }));
    api.on("input", (event: any, ctx: any) => {
      if (grant || active) return;
      if (event.text?.startsWith("/")) return;
      requestResume(event.text);
      return { action: "handled" };
    });
    api.on("before_agent_start", (event: any) => ({
      systemPrompt:
        event.systemPrompt +
        "\n\nPi Bots visibility contract: Before doing the assigned work, use todo to create a short plan belonging to this child. If a parent todo list was inherited, clear it first. Update the current item to in_progress before working and completed only after finishing it. Keep unfinished items truthful on interruption. The user can read and steer this exact session in its Pi TUI. Do not start another agent or change session identity to fulfil this task.",
    }));
    api.registerCommand("bot-resume", {
      description: "Continue this child through its native parent workflow",
      handler: async (args: string) => requestResume(args),
    });
    api.registerCommand("bot-reply", {
      description: "Answer this child's pending native supervisor question",
      handler: async (args: string) => {
        if (!args.trim()) throw Error("Provide an answer after /bot-reply.");
        const dir = path.join(runtime.supervisorChannelDir || "", "requests");
        const pending = fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((n) => n.endsWith(".json"))
              .map((n) => readJson(path.join(dir, n)))
              .filter((r) => r?.expectsReply)
          : [];
        if (pending.length !== 1)
          throw Error(
            "Use the parent supervisor to select among multiple questions, or inspect the already confirmed answer.",
          );
        const id = "tui-" + randomUUID(),
          file = path.join(
            path.dirname(descriptor.execution.parentJournal),
            "tui-requests",
            id + ".json",
          );
        atomicJson(file, {
          version: 1,
          id,
          kind: "supervisor_reply",
          replyTo: pending[0].id,
          runId: runtime.runId,
          index: runtime.childIndex,
          sessionFile: session.sessionFile,
          manifest: manifestFile,
          message: args,
          createdAt: Date.now(),
        });
        uiRequests.set(id, file);
        context.ui.notify("Answer submitted to the native supervisor.", "info");
      },
    });
  },
};
const factory = createDefaultChildSessionFactory({
  bindMode: "interactive",
  onSessionCreated: async (created: any, services: any) => {
    session = created;
    resources = services.resourceLoader;
    const originalAbort = session.abort.bind(session);
    const reportInterrupt = () => {
      if (active && !nativeAbort && !interrupted) {
        interrupted = true;
        channel.send({
          kind: "event",
          event: { type: "pi_bots_user_interrupt" },
        });
      }
    };
    session.abort = async () => {
      reportInterrupt();
      return originalAbort();
    };
    // Pi's Escape key aborts Agent directly; native stop uses AgentSession.
    const originalAgentAbort = session.agent.abort.bind(session.agent);
    session.agent.abort = () => {
      reportInterrupt();
      return originalAgentAbort();
    };
    const owner = new pi.AgentSessionRuntime(session, services, async () => {
      throw Error(
        "Managed Pi Bot: use /bot-resume to preserve native ownership.",
      );
    });
    pi.initTheme(services.settingsManager.getTheme(), true);
    tui = new pi.InteractiveMode(owner, { tuiMode: "fullscreen" });
    await tui.init();
  },
});
child = await factory.create({
  ...descriptor,
  runtime,
  hooks: [...createChildHooks(runtime), integration],
  onExtensionError: (error: any) =>
    callback("extensionError", { ...error, error: String(error.error) }),
});
child.subscribe((event: any) => channel.send({ kind: "event", event }));
// Pi owns the input loop, markdown rendering, tool cards and todo widget.
void tui.run().catch((error: any) => {
  channel.send({ kind: "failed", error: String(error) });
  process.exitCode = 1;
});
channel.events.on("message", async (message: any) => {
  if (message.kind !== "request") return;
  const reply = (ok: boolean, result?: any, error?: any) =>
    channel.send({
      kind: "reply",
      id: message.id,
      ok,
      result,
      error: error ? String(error) : undefined,
    });
  try {
    const args = message.args || {};
    switch (message.op) {
      case "snapshot":
        return reply(true, snapshot());
      case "arbitrateTask": {
        if (active || typeof args.text !== "string" || args.text.length > 8000)
          return reply(true, "unavailable");
        const arbiter = createTaskMutationArbiter(context);
        return reply(true, arbiter ? await arbiter(args.text) : "unavailable");
      }
      case "prompt": {
        if (active || closed)
          throw Error(
            "This native attempt has already started or released its session.",
          );
        active = true;
        grant = true;
        interrupted = false;
        try {
          const running = child.prompt(args.text);
          grant = false;
          await running;
          return reply(true, { ...snapshot(), interrupted });
        } finally {
          grant = false;
          active = false;
          channel.send({
            kind: "state",
            state: {
              state: "settled",
              ...snapshot(),
              messages: undefined,
              callbacks: undefined,
            },
          });
        }
      }
      case "steer":
        if (!active) throw Error("Child is settled; use native resume.");
        await child.steer(args.text);
        return reply(true, {});
      case "followUp":
        if (!active) throw Error("Child is settled; use native resume.");
        await child.followUp(args.text);
        return reply(true, {});
      case "abort":
        nativeAbort = true;
        try {
          await child.abort();
        } finally {
          nativeAbort = false;
        }
        return reply(true, {});
      case "release":
        closed = true;
        context?.ui.setStatus(
          "pi-bots",
          `Pi Bots · ${runtime.agent} · finished · /bot-resume <task>`,
        );
        return reply(true, {});
      case "retire":
        if (active) throw Error("Cannot retire an active child session.");
        await child.dispose();
        reply(true, {});
        setTimeout(() => process.exit(0), 100);
        return;
      case "bindView": {
        for (const key of Object.keys(process.env))
          if (key.startsWith("ORCA_") && key !== "ORCA_PI_STATUS_OWNED")
            delete process.env[key];
        for (const [key, value] of Object.entries(args.identity || {}))
          if (key.startsWith("ORCA_") && key !== "ORCA_PI_STATUS_OWNED")
            process.env[key] = String(value);
        // Rebind only the installed official status extension to the newly
        // attached terminal. Replaying every session hook would reset budgets.
        const official = resources
          .getExtensions()
          .extensions.find(
            (extension: any) =>
              path.resolve(extension.resolvedPath || extension.path) ===
              path.resolve(descriptor.execution.statusExtension),
          );
        for (const handler of official?.handlers.get("session_start") || [])
          await handler({ type: "session_start", reason: "resume" }, context);
        tui.ui.requestRender(true);
        return reply(true, {});
      }
      default:
        throw Error("Unsupported TUI operation: " + message.op);
    }
  } catch (error) {
    reply(false, undefined, error);
  }
});
channel.send({
  kind: "ready",
  session: { ...snapshot(), messages: undefined, callbacks: undefined },
});
setInterval(() => {
  for (const [id, file] of uiRequests) {
    const reply = readJson(file + ".reply.json");
    if (!reply) continue;
    uiRequests.delete(id);
    context?.ui.notify(
      reply.success
        ? "Native request confirmed."
        : String(reply.error || "Native request failed."),
      reply.success ? "info" : "error",
    );
  }
  if (active && runtime.supervisorChannelDir) {
    const dir = path.join(runtime.supervisorChannelDir, "requests");
    if (
      fs.existsSync(dir) &&
      fs
        .readdirSync(dir)
        .some((name) => readJson(path.join(dir, name))?.expectsReply)
    )
      context?.ui.setStatus(
        "pi-bots",
        `Pi Bots · ${runtime.agent} · needs answer: /bot-reply <answer>`,
      );
  }
}, 500).unref();
