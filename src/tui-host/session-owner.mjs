import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJson, atomicJson, connect, delay } from "./protocol.mjs";

export function sessionOwnerFile(registry, sessionFile) {
  // Pi publishes the planned session filename before the first durable message.
  const canonical = fs.existsSync(sessionFile)
    ? fs.realpathSync.native(sessionFile)
    : path.join(
        fs.realpathSync.native(path.dirname(sessionFile)),
        path.basename(sessionFile),
      );
  return path.join(
    registry,
    createHash("sha256")
      .update(
        process.platform === "win32" ? canonical.toLowerCase() : canonical,
      )
      .digest("hex") + ".json",
  );
}
export async function retireSessionOwner(registry, sessionFile, nextManifest) {
  if (!fs.existsSync(sessionFile)) return;
  const file = sessionOwnerFile(registry, sessionFile),
    owner = readJson(file);
  if (!owner || owner.manifest === nextManifest) return;
  const previous = readJson(owner.manifest);
  if (!previous || previous.sessionFile !== owner.sessionFile)
    throw Error("Previous TUI session owner is unconfirmed; cannot resume.");
  if (
    (previous.state === "retired" || previous.state === "exited") &&
    previous.exitObservedAt
  )
    return;
  const channel = await connect(owner.manifest);
  try {
    const live = await channel.call("status");
    if (
      !["settled", "released"].includes(live.state) ||
      !live.executionReleased
    )
      throw Error(
        "Previous Pi TUI attempt still owns execution; cannot resume.",
      );
    await channel.call("retire", {}, { id: "retire-" + owner.attempt });
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const current = readJson(owner.manifest);
      if (
        ["exited", "retired"].includes(current?.state) &&
        current.exitObservedAt
      )
        return;
      await delay(100);
    }
    throw Error(
      "Previous Pi TUI exit is unconfirmed; replacement remains blocked.",
    );
  } finally {
    channel.close();
  }
}
export function registerSessionOwner(registry, sessionFile, manifest, attempt) {
  atomicJson(sessionOwnerFile(registry, sessionFile), {
    version: 1,
    sessionFile,
    manifest,
    attempt,
  });
}
