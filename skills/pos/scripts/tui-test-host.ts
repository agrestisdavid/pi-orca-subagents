import fs from "node:fs";
import path from "node:path";
import piBots from "../../../extensions/pi-bots.ts";
export default function (pi: any) {
  let tool: any,
    context: any,
    busy = false;
  const root = process.env.PI_BOTS_TEST_CONTROL!;
  fs.mkdirSync(root, { recursive: true });
  piBots({
    ...pi,
    events: {
      ...pi.events,
      on(name: string, handler: any) {
        return pi.events.on(name, (message: any) => {
          if (
            name.startsWith("subagents:rpc:v1:reply:") &&
            ((process.env.PI_BOTS_TEST_DROP_SPAWN_REPLY === "1" &&
              message?.method === "spawn") ||
              (process.env.PI_BOTS_TEST_DROP_RESUME_REPLY === "1" &&
                message?.method === "resume"))
          ) {
            fs.writeFileSync(
              path.join(root, "dropped-reply.json"),
              JSON.stringify(message),
            );
            return;
          }
          handler(message);
        });
      },
    },
    registerTool(def: any) {
      if (def.name === "pi_bots") tool = def;
      pi.registerTool(def);
    },
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    context = ctx;
    pi.appendEntry("pi_bots_test_host", { startedAt: Date.now() });
    const sessionFile = ctx.sessionManager.getSessionFile();
    // Pi defers its first flush until an assistant turn. This model-free test
    // persists the real header/entries explicitly so --session tests a reload.
    if (!fs.existsSync(sessionFile)) {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        [ctx.sessionManager.getHeader(), ...ctx.sessionManager.getEntries()]
          .map(JSON.stringify)
          .join("\n") + "\n",
      );
    }
    fs.writeFileSync(
      path.join(root, "ready.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile,
      }),
    );
  });
  const timer = setInterval(async () => {
    if (!context || busy) return;
    busy = true;
    try {
      for (const name of fs
        .readdirSync(root)
        .filter((n) => /^command-[a-f0-9-]+\.json$/.test(n))) {
        const file = path.join(root, name),
          output = file + ".reply.json";
        if (fs.existsSync(output) || fs.existsSync(file + ".pending")) continue;
        fs.writeFileSync(file + ".pending", String(Date.now()), { flag: "wx" });
        const params = JSON.parse(fs.readFileSync(file, "utf8"));
        try {
          const result = params._native
            ? await new Promise<any>((resolve, reject) => {
                const requestId = name.replace(/\.json$/, "");
                const off = pi.events.on(
                  "subagents:rpc:v1:reply:" + requestId,
                  (reply: any) => {
                    off();
                    reply.success
                      ? resolve({ details: reply.data })
                      : reject(Error(JSON.stringify(reply.error)));
                  },
                );
                pi.events.emit("subagents:rpc:v1:request", {
                  version: 1,
                  requestId,
                  ...params._native,
                });
              })
            : await tool.execute(name, params, undefined, undefined, context);
          fs.writeFileSync(output, JSON.stringify(result));
        } catch (error) {
          fs.writeFileSync(
            output,
            JSON.stringify({
              isError: true,
              error: String(error?.stack || error),
            }),
          );
        }
      }
    } finally {
      busy = false;
    }
  }, 150);
  pi.on("session_shutdown", () => clearInterval(timer));
}
