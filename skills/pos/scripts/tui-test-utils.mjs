import { piCliPath } from '../../../src/pos/resources.mjs';
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  readJson,
  atomicJson,
  delay,
} from "../../../src/tui-host/protocol.mjs";
import { command } from "./orca-adapter.mjs";
export { readJson, atomicJson, delay };
export const cwd = path.resolve(process.env.POS_TEST_CWD || "tests/pi-bots-orca");
export async function until(test, message, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await test();
    if (r) return r;
    await delay(250);
  }
  throw Error("Timed out: " + message);
}
export async function orca(args) {
  const r = await command(
    path.join(process.env.LOCALAPPDATA, "Programs/orca/resources/bin/orca.exe"),
    [...args, "--json"],
  );
  assert(r.ok, JSON.stringify(r));
  return r.data.result;
}
export async function harness(label, { sessionFile, env = {} } = {}) {
  const root = path.join(cwd, label + "-" + Date.now());
  fs.mkdirSync(root, { recursive: true });
  const log = fs.openSync(path.join(root, "parent.log"), "w");
  const args = [
    piCliPath(),
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    path.resolve("native.ts"),
    "-e",
    path.resolve("skills/pos/scripts/tui-test-host.ts"),
    "--no-skills",
    "--no-context-files",
    "--offline",
  ];
  args.push(
    ...(sessionFile
      ? ["--session", sessionFile]
      : ["--session-dir", path.join(root, "sessions")]),
  );
  const parent = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env, PI_BOTS_TEST_CONTROL: root },
    windowsHide: true,
    stdio: ["pipe", log, log],
  });
  fs.closeSync(log);
  await until(
    () => readJson(path.join(root, "ready.json")),
    "parent ready",
    60000,
  );
  return {
    root,
    parent,
    async request(params) {
      const file = path.join(root, "command-" + randomUUID() + ".json");
      atomicJson(file, params);
      const r = await until(
        () => readJson(file + ".reply.json"),
        "parent command",
        150000,
      );
      if (r.isError) throw Error(JSON.stringify(r));
      return r;
    },
    close() {
      parent.kill();
    },
  };
}
