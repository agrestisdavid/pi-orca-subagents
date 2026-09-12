import { piCliPath } from '../../../src/pos/resources.mjs';
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { cwd, readJson, until } from "./tui-test-utils.mjs";
const root = path.join(cwd, "installed-" + Date.now());
fs.mkdirSync(root, { recursive: true });
const log = fs.openSync(path.join(root, "parent.log"), "w");
const p = spawn(
  process.execPath,
  [
    piCliPath(),
    "--mode",
    "rpc",
    "--no-skills",
    "--no-context-files",
    "--offline",
    "--session-dir",
    path.join(root, "sessions"),
    "-e",
    path.resolve("skills/pos/scripts/installed-backend-probe.ts"),
  ],
  {
    cwd,
    env: { ...process.env, PI_BOTS_TEST_CONTROL: root },
    stdio: ["pipe", log, log],
    windowsHide: true,
  },
);
fs.closeSync(log);
try {
  const result = await until(
    () => readJson(path.join(root, "installed.json")),
    "ordinary Pi extension discovery",
    60000,
  );
  assert(result.reply.success);
  assert.equal(result.reply.data.capabilities.childExecution.version, 1);
  for (const name of ["subagent", "subagent_supervisor", "pi_bots", "todo"])
    assert.equal(result.tools.filter((n) => n === name).length, 1, name);
  console.log(
    "PASS: Normal Pi startup selects the local backend and registers native tools, Pi Bots and todo exactly once. Evidence:",
    root,
  );
} finally {
  p.kill();
}
