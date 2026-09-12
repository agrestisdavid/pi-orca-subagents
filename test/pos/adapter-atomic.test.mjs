// The POS Orca adapter runs as a long-lived daemon in an Orca terminal and
// persists protocol files (cmd/reply/binding/daemon/health) on every tick.
// On Windows, rapid write+rename sequences can hit transient EPERM/EACCES/
// EBUSY directory/rename locks. The adapter must:
//
//  1. retry transient rename locks on the shared short ladder and succeed,
//  2. on a persistent lock RETHROW the original error — a discarded
//     long-lived command/reply/binding/daemon file must never look like a
//     successful write (live defect: the dispatch adapter silently dropped
//     health.json updates),
//  3. never return ok:true for an operation whose reply is not persisted,
//     and never re-invoke an operation after a claim was set
//     (live defect: first call returned success, reply file missing,
//     second call 'uncertain' — the result was lost with no error),
//  4. keep non-lock errors visible (no retry on ENOENT etc.).
import { test } from "node:test";
import { mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicJson, executeOnce } from "../../skills/pos/scripts/orca-adapter.mjs";

// The shared writer (src/shared/atomic-json.ts) imports node:fs as an ESM
// namespace; after patching the CJS exports the namespace must be re-synced
// for the fault to be visible to the writer.
const armRenameFault = (t, fn) => {
  t.mock.method(fs, "renameSync", fn);
  syncBuiltinESMExports();
};

const EPERM = Object.assign(new Error("EPERM: operation not permitted, rename"), {
  code: "EPERM",
});

test("transient rename lock: Windows retries; other platforms preserve the error", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-adapter-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, "health.json");
  const payload = { connected: true, updatedAt: 1 };

  // Fail the first two renames with EPERM (transient lock), then succeed.
  let renameCalls = 0;
  const originalRename = fs.renameSync;
  armRenameFault(t, (src, dest, cb) => {
    renameCalls++;
    if (renameCalls <= 2 && dest === file) {
      throw EPERM;
    }
    return originalRename(src, dest, cb);
  });

  if (process.platform === "win32") {
    atomicJson(file, payload);
    assert.equal(renameCalls, 3, "two EPERM retries then one successful rename");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), payload);
  } else {
    // The shared writer intentionally limits lock retries to Windows.
    assert.throws(() => atomicJson(file, payload), (error) => error === EPERM);
    assert.equal(renameCalls, 1, "permission errors on other platforms fail immediately");
    assert.equal(fs.existsSync(file), false);
  }
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "temp files must be cleaned up");
});

test("persistent rename lock: rethrow the original error, keep the previous target, clean up tmp", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-adapter-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, "reply.json");
  // Previous healthy content must survive a failed update.
  const previous = { connected: true, note: "previous" };
  fs.writeFileSync(file, JSON.stringify(previous));

  const originalRename = fs.renameSync;
  armRenameFault(t, (src, dest, cb) => {
    if (dest === file) {
      throw EPERM;
    }
    return originalRename(src, dest, cb);
  });

  assert.throws(
    () => atomicJson(file, { connected: false, note: "dropped-if-silent" }),
    (error) => {
      assert.equal(error.code, "EPERM", "the original error must be rethrown");
      assert.match(String(error), /EPERM: operation not permitted, rename/);
      return true;
    },
  );
  // Previous target intact, no tmp leftovers.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), previous);
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "temp files must be cleaned up on failure");
});

test("non-lock errors stay visible (no retry on ENOENT)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-adapter-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, "sub", "x.json");
  let renameCalls = 0;
  const originalRename = fs.renameSync;
  armRenameFault(t, (src, dest, cb) => {
    renameCalls++;
    if (dest === file) {
      const err = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      throw err;
    }
    return originalRename(src, dest, cb);
  });

  assert.throws(() => atomicJson(file, { a: 1 }), (error) => {
    assert.equal(error.code, "ENOENT");
    return true;
  });
  assert.equal(renameCalls, 1, "no retry for non-lock errors");
});

// --- executeOnce: success without a persisted reply must be impossible ---

function spoolFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-adapter-once-"));
  return dir;
}

test("executeOnce: persistence failure throws, no ok:true, and no re-invocation after the claim", async (t) => {
  const dir = spoolFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const originalRename = fs.renameSync;
  armRenameFault(t, (src, dest, cb) => {
    // Only the reply file is persistently locked; cmd input writes succeed.
    if (path.basename(dest) === "reply-first.json") {
      throw EPERM;
    }
    return originalRename(src, dest, cb);
  });

  let invoked = 0;
  const fakeRun = async (exe, args, timeout) => {
    invoked++;
    return { ok: true, invoked, data: { marker: args[1] } };
  };
  const args = ["orchestration", "run-create", "--repo", "x"];
  const exe = "orca";
  const id = "first";

  // First call: the operation is invoked exactly once, but the reply cannot
  // be persisted → it must throw (never return ok:true).
  await assert.rejects(
    () => executeOnce(dir, id, args, exe, fakeRun),
    (error) => {
      assert.equal(error.invoked, true);
      assert.match(String(error), /executed but its reply could not be persisted/);
      assert.match(String(error), /EPERM/);
      return true;
    },
  );
  assert.equal(invoked, 1, "the operation must be invoked exactly once");
  assert.ok(!fs.existsSync(path.join(dir, "reply-first.json")), "no reply file was persisted");
  assert.ok(fs.existsSync(path.join(dir, "cmd-first.json.claimed")), "claim must be held");

  // Second call: no replacement start, no re-invocation — 'uncertain' only.
  const second = await executeOnce(dir, id, args, exe, fakeRun);
  assert.equal(second.ok, false);
  assert.equal(second.uncertain, true);
  assert.match(String(second.error), /original outcome unknown/i);
  assert.equal(invoked, 1, "no second invocation after the claim was set");
});

test("executeOnce: a persisted notInvoked retry reply is released, a lost one blocks re-invocation", async (t) => {
  const dir = spoolFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const id = "retry";
  const input = path.join(dir, `cmd-${id}.json`);
  const output = path.join(dir, `reply-${id}.json`);
  const claim = input + ".claimed";
  fs.writeFileSync(input, JSON.stringify({ args: ["orchestration", "dispatch", "--x", "1"] }));
  // Prior outcome: the command was spawned but never invoked.
  fs.writeFileSync(output, JSON.stringify({ ok: false, notInvoked: true, error: "spawn failed" }));

  let invoked = 0;
  const fakeRun = async (exe, args, timeout) => {
    invoked++;
    return { ok: true, invoked };
  };

  // Scenario 1 (no lock): the notInvoked retry is invoked, persisted, and
  // the claim is released afterwards.
  const first = await executeOnce(dir, id, ["orchestration", "dispatch", "--x", "1"], "orca", fakeRun);
  assert.equal(first.ok, true);
  assert.equal(invoked, 1);
  assert.ok(!fs.existsSync(claim), "claim must be released after a persisted reply");

  // Scenario 2 (persistent lock on the reply): a second notInvoked state
  // whose retry reply cannot be persisted must throw and then report
  // 'uncertain' — never re-invoke.
  fs.writeFileSync(output, JSON.stringify({ ok: false, notInvoked: true, error: "spawn failed again" }));
  const originalRename = fs.renameSync;
  armRenameFault(t, (src, dest, cb) => {
    if (dest === output) {
      throw EPERM;
    }
    return originalRename(src, dest, cb);
  });

  await assert.rejects(
    () => executeOnce(dir, id, ["orchestration", "dispatch", "--x", "1"], "orca", fakeRun),
    (error) => {
      assert.equal(error.invoked, true);
      assert.match(String(error), /retried but its reply could not be persisted/);
      return true;
    },
  );
  assert.equal(invoked, 2, "the retry was invoked exactly once");
  assert.ok(fs.existsSync(claim), "the claim must be held after a lost retry reply");

  const second = await executeOnce(dir, id, ["orchestration", "dispatch", "--x", "1"], "orca", fakeRun);
  assert.equal(second.ok, false);
  assert.equal(second.uncertain, true);
  assert.equal(invoked, 2, "a lost retry reply must never lead to a re-invocation");
});
