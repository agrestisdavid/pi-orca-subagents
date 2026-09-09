import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicJson, readJson } from "../tui-host/protocol.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function requestReceiptFile(root, sessionId, requestId) {
  return path.join(
    root,
    "rpc-receipts-v1",
    hash(sessionId),
    hash(requestId) + ".json",
  );
}
export function claimRequest(file, request) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        request,
        state: "pending",
        createdAt: Date.now(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    return { claimed: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const prior = readJson(file);
  if (!prior || JSON.stringify(prior.request) !== JSON.stringify(request))
    throw Error(
      "Conflicting or unreadable original native RPC receipt; replacement blocked.",
    );
  return { claimed: false, ...prior };
}
export function settleRequest(file, reply) {
  const record = readJson(file);
  if (!record) throw Error("Original native request claim missing");
  // A transport listener throwing after a durable reply cannot change the
  // already confirmed mutation outcome into a failure.
  if (record.state === "received") return record.reply;
  atomicJson(file, {
    ...record,
    state: "received",
    reply,
    settledAt: Date.now(),
  });
}
export function readRequestReceipt(file) {
  const record = readJson(file);
  return record
    ? { version: 1, state: record.state, reply: record.reply }
    : { version: 1, state: "not_found" };
}
