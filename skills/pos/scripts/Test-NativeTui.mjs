import { piCliPath } from '../../../src/pos/resources.mjs';
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const cwd = path.resolve(process.env.POS_TEST_CWD || "tests/pi-bots-orca");
const log = fs.openSync(path.join(cwd, "tui-host.log"), "w");
const child = spawn(
  process.execPath,
  [
    piCliPath(),
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    path.resolve("native.ts"),
    "-e",
    path.resolve("skills/pos/scripts/native-tui-smoke-extension.ts"),
    "--no-skills",
    "--no-context-files",
    "--offline",
    "--session-dir",
    path.join(cwd, "tui-parent-sessions"),
  ],
  { cwd, windowsHide: true, stdio: ["pipe", log, log] },
);
fs.closeSync(log);
console.log("Isolated native TUI smoke host PID", child.pid);
child.on("error", console.error);
child.on("exit", (code) => {
  console.log("Smoke host exit", code);
  process.exitCode = code;
});
