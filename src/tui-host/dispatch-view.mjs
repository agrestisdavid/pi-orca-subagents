import fs from "node:fs";
import path from "node:path";
import { atomicJson, readJson, delay } from "./protocol.mjs";

// One durable first-child slot per workflow. Parallel/dynamic children cannot
// take it from its owner, including when its initial launch reply is lost.
export async function claimDispatchView(coordinationRoot, manifest, launch) {
  const mapping = readJson(path.join(coordinationRoot, "mapping.json"));
  if (mapping?.tuiViewPolicy !== "dispatch-first") return false;
  const file = path.join(coordinationRoot, "dispatch-tui.json");
  const claim = {
    version: 1, manifest, runId: launch.runtime.runId,
    index: launch.runtime.childIndex, claimedAt: Date.now(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(claim), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let prior = readJson(file);
  for (let n = 0; !prior?.manifest && n < 100; n++) {
    await delay(10);
    prior = readJson(file);
  }
  if (!prior?.manifest) throw Error("Original dispatch TUI claim is unreadable; replacement blocked.");
  if (prior.manifest === manifest) return true;
  const previous = readJson(prior.manifest);
  // Only a certified native resume of this same session can reuse the slot.
  if (launch.storage?.kind !== "file" || !previous?.sessionFile ||
      path.resolve(launch.storage.sessionFile) !== path.resolve(previous.sessionFile)) return false;
  if (!previous.exitObservedAt) throw Error("Previous dispatch TUI writer has not exited; replacement blocked.");
  const lock = file + ".resume-claim";
  fs.writeFileSync(lock, JSON.stringify({ manifest }), { flag: "wx" });
  try {
    if (readJson(file)?.manifest !== prior.manifest) throw Error("Dispatch TUI ownership changed during resume.");
    atomicJson(file, { ...claim, previousManifest: prior.manifest });
  } finally {
    fs.unlinkSync(lock);
  }
  return true;
}
