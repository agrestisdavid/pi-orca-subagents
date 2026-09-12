// Close only resources proven to belong to the isolated TUI acceptance fixtures.
// Keeps native status, paused results, receipts and all logs for inspection.
import fs from "node:fs";
import path from "node:path";
import { cwd, readJson, atomicJson, until, orca } from "./tui-test-utils.mjs";
import { queuedCommand, terminalPaneKey } from "./orca-bridge.mjs";
const base = path.join(
  process.env.TEMP,
  "pi-subagents-user-" + (process.env.USERNAME || process.env.USER || "unknown"),
  "async-subagent-runs",
);
const roots = new Set(),
  report = { closed: [], blocked: [] };
for (const id of fs.readdirSync(base)) {
  const dir = path.join(base, id),
    status = readJson(path.join(dir, "status.json"));
  if (
    path.resolve(status?.cwd || "") !== cwd ||
    !fs.existsSync(path.join(dir, "tui"))
  )
    continue;
  for (const name of fs.readdirSync(path.join(dir, "tui"))) {
    const file = name.endsWith(".json")
      ? readJson(path.join(dir, "tui", name))?.manifest
      : path.join(dir, "tui", name, "host.json");
    const host = file && readJson(file);
    if (!host?.coordinationRoot) continue;
    roots.add(host.coordinationRoot);
    try {
      process.kill(host.pid, 0);
      throw Error(
        "TUI host remains live; use explicit child stop/retirement before fixture cleanup.",
      );
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
for (const root of roots) {
  const map = readJson(path.join(root, "mapping.json"));
  if (path.resolve(map?.cwd || "") !== cwd)
    throw Error("Foreign coordination scope.");
  const native = readJson(path.join(root, "native-link.json")),
    state =
      native?.current &&
      readJson(path.join(native.current.asyncDir, "status.json"))?.state;
  const health = readJson(path.join(root, "health.json"));
  if (state === "paused" && !health?.done) {
    const result = await queuedCommand(map.worker.dir, "test-cleanup", [
      "send",
      "--type",
      "worker_done",
      "--subject",
      "Interrupted test fixture retired",
      "--body",
      "The acceptance test reached its intended interrupted/paused assertion. Its test-only Pi process and PTY host have now been explicitly retired. No remaining test work will run; the historical native paused result is preserved.",
      "--task-id",
      map.taskId,
      "--dispatch-id",
      map.dispatchId,
      "--outcome",
      "failed",
    ]).catch((error) => ({ error: String(error) }));
    if (!result.ok) {
      report.blocked.push({ root, error: result.error });
      continue;
    }
  }
  const listed = (await orca(["terminal", "list", "--worktree", "path:" + cwd]))
    .terminals;
  for (const role of ["coordinator", "worker"]) {
    const ep = map[role];
    fs.writeFileSync(path.join(ep.dir, "exit"), "");
    if (ep.ownedTerminal === false) continue;
    const owned = listed.find(
      (t) =>
        terminalPaneKey(t) === ep.terminal.paneKey &&
        t.tabId === ep.terminal.tabId,
    );
    if (owned) {
      await orca(["terminal", "close", "--terminal", owned.handle]);
      report.closed.push(owned.handle);
    }
  }
  // A model-free workflow owner can be terminated once all its known child
  // PTY hosts have exited. PowerShell verifies the exact command line/PID next.
  const file = path.join(root, "native-workflow-host", "host.json"),
    owner = readJson(file);
  if (owner?.pid) {
    const launch = readJson(path.join(path.dirname(file), "launch.json"));
    if (path.resolve(launch?.cwd || "") !== cwd)
      throw Error("Foreign native workflow owner.");
    atomicJson(path.join(path.dirname(file), "test-cleanup-authorized.json"), {
      pid: owner.pid,
      root: path.dirname(file),
      cwd,
      at: Date.now(),
      reason: "All owned acceptance fixture PTYs have exited.",
    });
  }
}
atomicJson(path.join(cwd, "fixture-cleanup.json"), report);
console.log(
  "Verified test adapter views closed:",
  report.closed.length,
  "Blocked:",
  report.blocked.length,
);
