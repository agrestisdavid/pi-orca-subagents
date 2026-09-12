import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createAtomicJsonWriter } from "../shared/atomic-json.ts";
import { resolveFileSystemRetryDelays } from "../shared/file-system-retry.ts";

export const VERSION = 1;
export const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
// The TUI host exchanges status files on a hot path of a long-lived process.
// The shared writer's default ladder can sleep ~7.9s, which would stall the
// broker's event loop. Use the short four-step Windows ladder instead
// (10/25/50/100ms, at most 185ms per exchange); a lower configured retry
// budget (PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS) stays effective. Successful
// writes never wait. Retry only applies to rename errors EPERM/EACCES/EBUSY
// on Windows; the target file is never pre-deleted, and a persistent failure
// rethrows the original error.
export const TUI_RENAME_RETRY_DELAYS_MS = resolveFileSystemRetryDelays().slice(0, 4);
export const atomicJson = createAtomicJsonWriter({
  mode: 0o600,
  retryDelaysMs: TUI_RENAME_RETRY_DELAYS_MS,
});
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function jsonSocket(socket, onMessage, onError = () => {}) {
  let pending = "";
  socket.setEncoding("utf8");
  socket.setNoDelay(true);
  socket.on("data", (chunk) => {
    pending += chunk;
    // The bound is per frame, never a transcript/history limit.
    if (pending.length > 64 * 1024 * 1024) {
      socket.destroy(Error("Protocol frame exceeds 64 MB"));
      return;
    }
    let split;
    while ((split = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, split);
      pending = pending.slice(split + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (error) {
        onError(error);
      }
    }
  });
  socket.on("error", onError);
  return (message) => {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
  };
}
export async function connect(manifestFile, role = "control", extra = {}) {
  const manifest = readJson(manifestFile);
  if (
    manifest?.version !== VERSION ||
    !Number.isInteger(manifest.port) ||
    !manifest.token
  )
    throw Error("TUI host identity is unavailable: " + manifestFile);
  const socket = net.connect({ host: "127.0.0.1", port: manifest.port });
  const events = new EventEmitter();
  const requests = new Map();
  const send = jsonSocket(
    socket,
    (message) => {
      if (message.kind === "reply") {
        const pending = requests.get(message.id);
        if (!pending) return;
        requests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(Error(message.error || "TUI operation failed"));
      } else events.emit("message", message);
    },
    (error) => events.emit("fault", error),
  );
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const hello = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("TUI handshake timeout")),
      5000,
    );
    const listener = (m) => {
      if (m.kind === "hello") {
        clearTimeout(timer);
        events.off("message", listener);
        resolve(m);
      }
    };
    events.on("message", listener);
  });
  send({
    kind: "hello",
    version: VERSION,
    token: manifest.token,
    role,
    ...extra,
  });
  await hello;
  socket.on("close", () => {
    for (const r of requests.values()) {
      clearTimeout(r.timer);
      r.reject(
        Error(
          "TUI host connection lost; outcome may be pending. Do not repeat the operation.",
        ),
      );
    }
    requests.clear();
    events.emit("closed");
  });
  events.on("fault", () => {});
  return {
    socket,
    events,
    send,
    manifest,
    call(op, args = {}, options = {}) {
      const id = options.id || randomUUID();
      return new Promise((resolve, reject) => {
        const timer =
          options.timeout === 0
            ? undefined
            : setTimeout(() => {
                requests.delete(id);
                reject(
                  Error(
                    `TUI ${op} response pending (${id}); original request retained.`,
                  ),
                );
              }, options.timeout ?? 90000);
        requests.set(id, { resolve, reject, timer });
        send({ kind: "request", id, op, args });
      });
    },
    close() {
      socket.end();
    },
  };
}
