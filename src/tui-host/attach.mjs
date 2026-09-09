/** Thin terminal transport: all UI bytes and navigation come from Pi itself. */
import { connect } from "./protocol.mjs";
const identity = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key.startsWith("ORCA_") && key !== "ORCA_PI_STATUS_OWNED",
  ),
);
const channel = await connect(process.argv[2], "view", {
  identity,
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 40,
});
let ending = false;
function close() {
  if (ending) return;
  ending = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  channel.close();
  process.exit(0);
}
channel.events.on("message", (message) => {
  if (message.kind === "output") process.stdout.write(message.data);
  if (message.kind === "notice")
    process.stdout.write("\r\n" + message.text + "\r\n");
});
channel.events.on("closed", close);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) =>
  channel.send({ kind: "input", data: data.toString("utf8") }),
);
process.stdout.on("resize", () =>
  channel.send({
    kind: "resize",
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  }),
);
process.on("SIGHUP", close);
process.on("SIGTERM", close);
