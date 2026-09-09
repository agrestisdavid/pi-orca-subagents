import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { connect, readJson, delay } from "./protocol.mjs";
/** Reconcile the original request receipt after a dropped local connection. */
export async function reconnectingChannel(manifest) {
  const events = new EventEmitter();
  let current,
    connecting,
    closed = false,
    sequence = 0;
  async function establish() {
    if (connecting) return connecting;
    if (current && !current.socket.destroyed) return current;
    connecting = (async () => {
      while (!closed) {
        try {
          const client = await connect(manifest);
          client.events.on("message", (message) => {
            if (message.sequence) {
              if (message.sequence <= sequence) return;
              sequence = message.sequence;
            }
            events.emit("message", message);
          });
          client.events.on("closed", () => {
            if (current === client) current = undefined;
          });
          current = client;
          await client.call("replay", { after: sequence });
          return client;
        } catch (error) {
          const host = readJson(manifest);
          try {
            if (!host?.pid) throw Error("missing host identity");
            process.kill(host.pid, 0);
          } catch {
            throw Object.assign(
              Error(
                "TUI host disappeared; its original execution outcome must be reconciled.",
              ),
              { uncertain: true },
            );
          }
          await delay(250);
        }
      }
      throw Error("TUI control channel is closed");
    })().finally(() => (connecting = undefined));
    return connecting;
  }
  await establish();
  return {
    events,
    async call(op, args = {}, options = {}) {
      const id = options.id || randomUUID();
      while (!closed) {
        const client = await establish();
        try {
          return await client.call(op, args, { ...options, id });
        } catch (error) {
          if (!/connection lost|response pending/.test(String(error)))
            throw error;
          client.close();
          current = undefined;
          await delay(150);
        }
      }
      throw Error("TUI control channel is closed");
    },
    close() {
      closed = true;
      current?.close();
    },
  };
}
