import fs from "node:fs";
import path from "node:path";
import {
  readJson,
  connect,
  delay,
} from "../../../src/tui-host/protocol.mjs";
import { command } from "./orca-adapter.mjs";
const testCwd = path.resolve(process.env.POS_TEST_CWD || "tests/pi-bots-orca");
const exe = path.join(
  process.env.LOCALAPPDATA,
  "Programs/orca/resources/bin/orca.exe",
);
const hostsOnly = process.argv.includes("--hosts-only");
for (const id of process.argv.slice(2).filter((x) => x !== "--hosts-only")) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Explicit test run ID required");
  const dir = path.join(
    process.env.TEMP,
    "pi-subagents-user-" + (process.env.USERNAME || process.env.USER || "unknown"),
    "async-subagent-runs",
    id,
  );
  const status = readJson(path.join(dir, "status.json"));
  if (path.resolve(status?.cwd || "") !== testCwd)
    throw Error("Run is outside the isolated test directory");
  const roots = new Set();
  const tui = path.join(dir, "tui");
  const manifests = new Set();
  for (const name of fs.existsSync(tui) ? fs.readdirSync(tui) : []) {
    const candidate = name.endsWith(".json")
      ? readJson(path.join(tui, name))?.manifest
      : path.join(tui, name, "host.json");
    if (candidate) manifests.add(candidate);
  }
  for (const manifest of manifests) {
    const host = readJson(manifest),
      launch = readJson(path.join(path.dirname(manifest), "launch.json"));
    if (!host) continue;
    if (path.resolve(launch?.cwd || "") !== testCwd)
      throw Error("TUI belongs to a different working directory.");
    roots.add(host.coordinationRoot);
    let c;
    try {
      process.kill(host.pid, 0);
      c = await connect(manifest);
      await c.call("abort", {}, { timeout: 5000 }).catch(() => {});
      await c.call("release", {}, { timeout: 5000 }).catch(() => {});
      await delay(200);
      await c.call("retire", {}, { timeout: 5000 }).catch(() => {});
      await delay(400);
      await c.call("shutdown");
    } catch (error) {
      console.log(id, "host cleanup:", String(error));
    } finally {
      c?.close();
    }
    if (host.view?.handle)
      await command(exe, [
        "terminal",
        "close",
        "--terminal",
        host.view.handle,
        "--json",
      ]);
  }
  if (!hostsOnly)
    for (const root of roots) {
      const map = readJson(path.join(root, "mapping.json"));
      if (
        map?.nativeRuns?.some((r) => r.runId === id) &&
        ["complete", "failed", "stopped", "partial", "rejected"].includes(
          status.state,
        )
      )
        for (const role of ["coordinator", "worker"])
          if (map[role]?.terminal?.handle) {
            fs.writeFileSync(path.join(map[role].dir, "exit"), "");
            if (map[role].ownedTerminal === false) continue;
            await command(exe, [
              "terminal",
              "close",
              "--terminal",
              map[role].terminal.handle,
              "--json",
            ]);
          }
    }
  console.log("Cleaned only test-owned processes/views:", id);
}
