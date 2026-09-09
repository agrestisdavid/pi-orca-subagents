import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  requestReceiptFile,
  claimRequest,
  settleRequest,
  readRequestReceipt,
} from "../../src/api/request-receipts.mjs";
import {
  withChildExecution,
  childExecutionRequirements,
  currentChildExecution,
} from "../../src/api/child-execution.ts";
import {
  sessionOwnerFile,
  registerSessionOwner,
  retireSessionOwner,
} from "../../src/tui-host/session-owner.mjs";
import { atomicJson } from "../../src/tui-host/protocol.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tui-authority-"));
const mode = {
  version: 1,
  type: "orca-tui",
  coordinationRoot: root,
  parentJournal: path.join(root, "journal.json"),
  todoExtension: path.join(root, "todo.ts"),
  statusExtension: path.join(root, "status.ts"),
};
for (const file of [
  mode.todoExtension,
  mode.statusExtension,
  path.join(root, "mapping.json"),
])
  fs.writeFileSync(file, "{}");
test("original requests retain ownership across reload, conflict and session boundaries", () => {
  const request = {
    version: 1,
    requestId: "original",
    method: "spawn",
    params: { task: "a" },
  };
  const file = requestReceiptFile(root, "owner", request.requestId);
  assert.equal(claimRequest(file, request).claimed, true);
  assert.equal(claimRequest(file, request).claimed, false);
  assert.equal(readRequestReceipt(file).state, "pending");
  assert.throws(
    () => claimRequest(file, { ...request, params: { task: "replacement" } }),
    /Conflicting/,
  );
  settleRequest(file, { success: true, data: { runId: "one" } });
  settleRequest(file, {
    success: false,
    error: "A reply listener threw after delivery",
  });
  assert.equal(claimRequest(file, request).reply.data.runId, "one");
  assert.equal(
    readRequestReceipt(requestReceiptFile(root, "foreign", request.requestId))
      .state,
    "not_found",
  );
});
test("concurrent workflows do not leak their execution selection", async () => {
  await Promise.all([
    withChildExecution(mode, async () => {
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(currentChildExecution().type, "orca-tui");
    }),
    withChildExecution(undefined, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(currentChildExecution(), undefined);
    }),
  ]);
  assert.equal(currentChildExecution(), undefined);
});
test("required UI tools obey both current and inherited capability ceilings", () =>
  withChildExecution(mode, () => {
    const planned = childExecutionRequirements({ tools: ["read"] });
    assert.deepEqual(planned.tools, ["read", "todo"]);
    assert(planned.subagentOnlyExtensions.includes(mode.todoExtension));
    assert(planned.subagentOnlyExtensions.includes(mode.statusExtension));
    for (const value of [
      { excludeTools: ["todo"] },
      { capabilityCeiling: { allowedTools: ["read"] } },
      { inheritedCapabilityCeiling: { denyExtensions: true } },
    ])
      assert.throws(() => childExecutionRequirements(value), /requires/);
  }));
test("a planned session filename can be registered before its first message", () => {
  const file = path.join(root, "session", "new.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  registerSessionOwner(root, file, path.join(root, "host.json"), "attempt");
  assert(fs.existsSync(sessionOwnerFile(root, file)));
});
test("uncertain previous session ownership blocks another writer", async () => {
  const file = path.join(root, "owned.jsonl");
  fs.writeFileSync(file, "{}\n");
  const manifest = path.join(root, "unknown-host.json");
  registerSessionOwner(root, file, manifest, "attempt");
  await assert.rejects(
    () => retireSessionOwner(root, file, path.join(root, "replacement.json")),
    /unconfirmed/,
  );
  atomicJson(manifest, { sessionFile: file, state: "running", version: 1 });
  await assert.rejects(
    () => retireSessionOwner(root, file, path.join(root, "replacement.json")),
    /identity is unavailable/,
  );
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
