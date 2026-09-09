import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ChildSessionFactory,
  ChildSession,
  ChildSessionLaunch,
} from "../runs/shared/child-session.ts";
import type { ChildExecution } from "../api/child-execution.ts";
import { atomicJson, readJson, delay, connect } from "./protocol.mjs";
import { retireSessionOwner, registerSessionOwner } from "./session-owner.mjs";
import { reconnectingChannel } from "./reconnecting-channel.mjs";

export function createTuiChildSessionFactory(config: {
  childExecution: ChildExecution;
  asyncDir: string;
  piPackageRoot: string;
}): ChildSessionFactory {
  const live = new Set<ChildSession>();
  return {
    async create(launch: ChildSessionLaunch) {
      if (process.platform !== "win32")
        throw new Error(
          "This Orca TUI backend currently requires Windows ConPTY.",
        );
      if (!path.isAbsolute(config.asyncDir))
        throw new Error("Missing native async directory for TUI host.");
      const attempt = randomUUID();
      const root = path.join(
        config.asyncDir,
        "tui",
        `${launch.runtime.childIndex}-${attempt}`,
      );
      fs.mkdirSync(root, { recursive: true });
      const manifest = path.join(root, "host.json");
      const registry = path.join(
        path.dirname(path.dirname(config.asyncDir)),
        "tui-session-owners",
      );
      if (launch.storage.kind === "file")
        await retireSessionOwner(
          registry,
          launch.storage.sessionFile,
          manifest,
        );
      // Claim the next writer before starting its process. A lost startup
      // acknowledgement must not leave the registry pointing at a retired one.
      if (launch.storage.kind === "file")
        registerSessionOwner(
          registry,
          launch.storage.sessionFile,
          manifest,
          attempt,
        );
      const descriptor = JSON.parse(
        JSON.stringify(
          {
            ...launch,
            hooks: undefined,
            onExtensionError: undefined,
            execution: config.childExecution,
            piPackageRoot: config.piPackageRoot,
            aliases: process.env.JITI_ALIAS,
          },
          (_key, value) => (typeof value === "function" ? undefined : value),
        ),
      );
      atomicJson(path.join(root, "launch.json"), descriptor);
      atomicJson(
        path.join(
          config.asyncDir,
          "tui",
          `child-${launch.runtime.childIndex}.json`,
        ),
        {
          version: 1,
          manifest,
          attempt,
          runId: launch.runtime.runId,
          index: launch.runtime.childIndex,
        },
      );
      const broker = fileURLToPath(new URL("./broker.mjs", import.meta.url));
      const errorLog = fs.openSync(path.join(root, "broker.log"), "a");
      const processHost = spawn(process.execPath, [broker, root], {
        cwd: launch.cwd,
        env: process.env,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", errorLog, errorLog],
      });
      processHost.unref();
      fs.closeSync(errorLog);
      atomicJson(path.join(root, "start.json"), {
        attempt,
        pid: processHost.pid,
        at: Date.now(),
      });
      let spawnError: Error | undefined;
      processHost.on("error", (error) => (spawnError = error));
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        const state = readJson(manifest);
        if (state?.state === "ready") break;
        if (["failed", "exited"].includes(state?.state))
          throw new Error(
            `Pi TUI child failed: ${state.error || state.exitCode}. Inspect ${root}`,
          );
        await delay(150);
      }
      if (readJson(manifest)?.state !== "ready")
        throw new Error(
          `Pi TUI startup remains unconfirmed at ${manifest}; no replacement was created.`,
        );
      const channel = await reconnectingChannel(manifest);
      let info: any = readJson(manifest),
        messages: any[] = [];
      const listeners = new Set<(event: any) => void>();
      let closed = false;
      const callbacks = (name: string, args: any[]) => {
        if (name === "extensionError")
          launch.onExtensionError?.({
            ...args[0],
            error: new Error(args[0].error),
          });
        else if (name === "structuredOutput")
          launch.runtime.structuredOutput?.capture(args[0], args[1]);
        else if (name === "toolDiagnostic")
          launch.runtime.toolDiagnostic?.(args[0]);
        else if (name === "runtimeAcknowledgements")
          launch.runtime.runtimeAcknowledgements?.(args[0]);
        else if (name === "watchdogStatus")
          launch.runtime.watchdogStatus?.(args[0]);
      };
      channel.events.on("message", (message: any) => {
        if (message.kind === "event")
          for (const listener of listeners) listener(message.event);
        if (message.kind === "callback") callbacks(message.name, message.args);
        if (message.kind === "state") Object.assign(info, message.state);
        if (["failed", "exited"].includes(message.kind) && !closed)
          for (const listener of listeners)
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: message.error || "Pi TUI process exited",
                timestamp: Date.now(),
              },
            });
      });
      const snapshot = await channel.call("snapshot");
      info = { ...info, ...snapshot };
      messages = snapshot.messages || [];
      if (info.sessionFile)
        registerSessionOwner(registry, info.sessionFile, manifest, attempt);
      atomicJson(
        path.join(
          config.childExecution.coordinationRoot,
          "children",
          `native-${launch.runtime.runId}-${launch.runtime.childIndex}.json`,
        ),
        {
          version: 1,
          runId: launch.runtime.runId,
          index: launch.runtime.childIndex,
          attempt,
          manifest,
          asyncDir: config.asyncDir,
          sessionId: info.sessionId,
          sessionFile: info.sessionFile,
        },
      );
      for (const callback of snapshot.callbacks || [])
        callbacks(callback.name, callback.args);
      const child: ChildSession = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(text) {
          const result = await channel.call("prompt", { text }, { timeout: 0 });
          messages = result.messages;
          Object.assign(info, result);
        },
        async steer(text) {
          await channel.call("steer", { text });
        },
        async followUp(text) {
          await channel.call("followUp", { text });
        },
        async abort() {
          await channel.call("abort");
        },
        async dispose() {
          if (closed) return;
          closed = true;
          live.delete(child);
          try {
            await channel.call("release", {}, { timeout: 10000 });
          } finally {
            channel.close();
          }
        },
        get messages() {
          return messages;
        },
        get sessionFile() {
          return info.sessionFile;
        },
        get sessionId() {
          return info.sessionId;
        },
        get modelId() {
          return info.modelId;
        },
      };
      live.add(child);
      return child;
    },
    async dispose() {
      for (const child of [...live])
        if (!child.detached) {
          child.shutDown = true;
          await child.abort().catch(() => {});
          await child.dispose();
        }
    },
  };
}
