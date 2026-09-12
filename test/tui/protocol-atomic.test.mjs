// TUI host atomic JSON exchange: short Windows retry ladder, original error
// preserved, target never pre-deleted, own temp cleaned up (create-beta).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicJson,
  readJson,
  TUI_RENAME_RETRY_DELAYS_MS,
} from "../../src/tui-host/protocol.mjs";
import { createAtomicJsonWriter } from "../../src/shared/atomic-json.ts";
import { resolveFileSystemRetryDelays } from "../../src/shared/file-system-retry.ts";

function errno(code) {
  const error = new Error(`rename failed with ${code}`);
  error.code = code;
  return error;
}

class FakeFs {
  constructor() {
    this.files = new Map();
    this.renameAttempts = 0;
    this.failRenameCodes = [];
    this.writeOptions = new Map();
    this.rmCalls = [];
    this.targetDeleted = false;
  }
  mkdirSync() {}
  writeFileSync(filePath, contents, options) {
    this.files.set(filePath, contents);
    this.writeOptions.set(filePath, options);
  }
  renameSync(sourcePath, targetPath) {
    this.renameAttempts += 1;
    const failureCode = this.failRenameCodes.shift();
    if (failureCode) throw errno(failureCode);
    const contents = this.files.get(sourcePath);
    if (contents === undefined) throw new Error(`missing source: ${sourcePath}`);
    this.files.delete(sourcePath);
    this.files.set(targetPath, contents);
  }
  rmSync(filePath) {
    this.rmCalls.push(filePath);
    if (filePath.endsWith("host.json")) this.targetDeleted = true;
    this.files.delete(filePath);
  }
}

function tuiWriter(fakeFs, waits) {
  return createAtomicJsonWriter({
    fs: fakeFs,
    now: () => 12345,
    pid: 678,
    random: () => 0.5,
    mode: 0o600,
    // The platform gating (Windows only) belongs to the protocol.mjs
    // configuration; here the short ladder logic itself is pinned.
    retryRenameErrors: true,
    retryDelaysMs: TUI_RENAME_RETRY_DELAYS_MS,
    wait: (ms) => waits.push(ms),
  });
}

test("the TUI host exchange is capped at 185ms of retry waiting", () => {
  assert.equal(TUI_RENAME_RETRY_DELAYS_MS.length, 4);
  const total = TUI_RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(total <= 185, `ladder total ${total}ms exceeds 185ms`);
  // Without a configured lower budget this is the documented short ladder.
  if (process.env.PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS === undefined)
    assert.deepEqual([...TUI_RENAME_RETRY_DELAYS_MS], [10, 25, 50, 100]);
  else
    assert.deepEqual(
      [...TUI_RENAME_RETRY_DELAYS_MS],
      [...resolveFileSystemRetryDelays()].slice(0, 4),
    );
});

test("transient EPERM is retried on the short ladder, then succeeds", () => {
  const fakeFs = new FakeFs();
  fakeFs.failRenameCodes = ["EPERM", "EPERM", "EBUSY"];
  const waits = [];
  const target = path.join("C:", "tmp", "host.json");
  tuiWriter(fakeFs, waits)(target, { state: "ready" });
  assert.equal(fakeFs.renameAttempts, 4);
  assert.deepEqual(waits, [10, 25, 50]);
  assert.equal(fakeFs.files.get(target), JSON.stringify({ state: "ready" }, null, 2));
  assert.equal(fakeFs.files.size, 1, "no temp file left behind");
  assert.ok(
    [...fakeFs.writeOptions.values()].some(
      (o) => o && o.mode === 0o600 && o.encoding === "utf-8",
    ),
    "temp file is written with mode 0600",
  );
});

test("a persistent lock rethrows the original error without deleting the target", () => {
  const fakeFs = new FakeFs();
  fakeFs.failRenameCodes = Array(99).fill("EPERM");
  const waits = [];
  const target = path.join("C:", "tmp", "host.json");
  assert.throws(
    () => tuiWriter(fakeFs, waits)(target, { state: "ready" }),
    (error) => error.code === "EPERM" && /EPERM/.test(error.message),
  );
  assert.equal(fakeFs.renameAttempts, 5, "1 initial + 4 retries, then the original error");
  assert.deepEqual(waits, [10, 25, 50, 100], "the full 185ms budget");
  assert.equal(fakeFs.targetDeleted, false, "the existing target is never pre-deleted");
  assert.ok(
    fakeFs.rmCalls.some((f) => !f.endsWith("host.json")),
    "the own temp file is cleaned up",
  );
  assert.equal(fakeFs.files.get(target), undefined, "the target content is untouched");
});

test("a non-retryable error is surfaced immediately", () => {
  const fakeFs = new FakeFs();
  fakeFs.failRenameCodes = ["EINVAL"];
  const waits = [];
  const target = path.join("C:", "tmp", "host.json");
  assert.throws(
    () => tuiWriter(fakeFs, waits)(target, { state: "ready" }),
    (error) => error.code === "EINVAL",
  );
  assert.equal(fakeFs.renameAttempts, 1);
  assert.deepEqual(waits, []);
});

test("a successful exchange never waits", () => {
  const fakeFs = new FakeFs();
  const waits = [];
  const target = path.join("C:", "tmp", "host.json");
  tuiWriter(fakeFs, waits)(target, { state: "ready" });
  assert.deepEqual(waits, []);
});

test("the real exchange round-trips and leaves no temp files behind", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tui-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "host.json");
  atomicJson(target, { state: "starting" });
  atomicJson(target, { state: "ready", port: 1234 });
  assert.deepEqual(readJson(target), { state: "ready", port: 1234 });
  const leftovers = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});
