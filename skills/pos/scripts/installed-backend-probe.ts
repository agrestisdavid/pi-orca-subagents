import fs from "node:fs";
import path from "node:path";
export default function (pi: any) {
  pi.on("session_start", () => {
    setTimeout(() => {
      const id = "installed-backend-probe-" + process.pid;
      const off = pi.events.on("subagents:rpc:v1:reply:" + id, (reply: any) => {
        off();
        fs.writeFileSync(
          path.join(process.env.PI_BOTS_TEST_CONTROL!, "installed.json"),
          JSON.stringify({
            reply,
            tools: pi.getAllTools().map((tool: any) => tool.name),
          }),
        );
      });
      pi.events.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId: id,
        method: "ping",
      });
    }, 300);
  });
}
