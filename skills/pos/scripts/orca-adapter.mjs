// A model-free endpoint. It executes only Orca orchestration commands from its
// private workflow spool, in the environment of its own assigned Orca terminal.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createAtomicJsonWriter } from "../../../src/shared/atomic-json.ts";
import { resolveFileSystemRetryDelays } from "../../../src/shared/file-system-retry.ts";

// The adapter is a long-lived daemon on a hot path: use the shared writer
// with the short Windows ladder (10/25/50/100ms, at most 185ms per write; a
// lower PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS budget stays effective). The
// shared writer never deletes the previous target, cleans up its temp file,
// and RETHROWS the original error on a persistent rename failure. That
// contract is deliberate here: a discarded long-lived command/reply/binding/
// daemon file must never look like a successful write. The per-tick health
// report and the loop-side writes are caught below (a stale health report is
// the parent's visible warning) instead of crashing the daemon.
const ADAPTER_RETRY_DELAYS_MS = resolveFileSystemRetryDelays().slice(0, 4);
export const atomicJson = createAtomicJsonWriter({
  mode: 0o600,
  retryDelaysMs: ADAPTER_RETRY_DELAYS_MS,
});
export function command(exe, args, timeout = 30000) {
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      settled = false;
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        uncertain: true,
        error: "Orca command timed out",
        stdout,
        stderr,
      });
    }, timeout);
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.on("error", (e) =>
      finish({ ok: false, notInvoked: true, error: e.message, stdout, stderr }),
    );
    child.on("close", (code) => {
      let data;
      try {
        data = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
      } catch {}
      finish({ ok: code === 0, code, data, stdout, stderr });
    });
  });
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const hash = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);
export async function executeOnce(dir, id, args, exe, runCommand = command) {
  const input = path.join(dir, `cmd-${id}.json`),
    output = path.join(dir, `reply-${id}.json`),
    claim = input + ".claimed";
  const req = { args };
  if (!fs.existsSync(input)) atomicJson(input, req);
  else if (JSON.stringify(readJson(input)?.args) !== JSON.stringify(args))
    throw Error(`Conflicting original operation ${id}`);
  let prior = readJson(output);
  if (prior?.notInvoked) {
    // The retry is a real invocation. The claim is held from invocation
    // until the reply is persisted (released best-effort below). If a
    // claim is held while the notInvoked reply is still visible, a previous
    // retry was invoked but its reply was lost: report uncertain instead of
    // re-invoking.
    if (fs.existsSync(claim))
      return {
        ok: false,
        uncertain: true,
        error:
          "Previous retry of this notInvoked operation is unconfirmed; original outcome unknown. No replacement issued.",
      };
    fs.writeFileSync(claim, "", { flag: "wx" });
    const retried = await runCommand(exe, args, 45000);
    try {
      atomicJson(output, retried);
    } catch (error) {
      throw Object.assign(
        new Error(
          `Operation ${id} retried but its reply could not be persisted (${error.message}). Original outcome unknown; no replacement will be issued.`,
        ),
        { invoked: true },
      );
    }
    // Reply persisted: the claim has served its purpose. Best-effort
    // release — a leftover claim only makes a later missing reply
    // 'uncertain', never a re-invocation.
    try {
      fs.rmSync(claim, { force: true });
    } catch {}
    return retried;
  }
  if (prior) {
    const recovery =
      prior.data?.error?.data?.recovery || prior.data?.data?.recovery;
    if (!recovery?.orchestrationRequestId) return prior;
    const query = await runCommand(exe, [
      "orchestration",
      "request-show",
      "--request",
      recovery.orchestrationRequestId,
      "--json",
    ]);
    atomicJson(input + ".recovery.json", query);
    const state = query.data?.result?.state;
    if (!query.ok || !["completed", "pending"].includes(state)) return prior;
    // Reuse the exact persisted command with Orca's original operation ID.
    prior = await runCommand(
      exe,
      [...args, "--retry-request", recovery.orchestrationRequestId],
      45000,
    );
    try {
      atomicJson(output, prior);
    } catch (error) {
      throw Object.assign(
        new Error(
          `Operation ${id} completed but its reply could not be persisted (${error.message}). Original outcome unknown; no replacement will be issued.`,
        ),
        { invoked: true },
      );
    }
    return prior;
  }
  if (fs.existsSync(claim))
    return {
      ok: false,
      uncertain: true,
      error:
        "Adapter stopped during command; original outcome unknown. No replacement issued.",
    };
  fs.writeFileSync(claim, "", { flag: "wx" });
  const result = await runCommand(exe, args, 45000);
  try {
    atomicJson(output, result);
  } catch (error) {
    // The original operation was invoked; only its receipt is missing.
    // Confirming success would lose the reply, and re-executing would run
    // the operation twice. The claim stays, so the next caller sees
    // 'uncertain' instead of a replacement start.
    throw Object.assign(
      new Error(
        `Operation ${id} executed but its reply could not be persisted (${error.message}). Original outcome unknown; no replacement will be issued.`,
      ),
      { invoked: true },
    );
  }
  // Reply persisted: best-effort claim release (see the notInvoked path).
  try {
    fs.rmSync(claim, { force: true });
  } catch {}
  return result;
}

export async function tickWorkflow(dir, exe, runCommand = command) {
  const root = path.dirname(dir),
    mapping = readJson(path.join(root, "mapping.json"));
  if (!mapping || path.basename(dir) !== "workflow") return;
  const report = readJson(path.join(root, "health.json")) || {
    questions: {},
    heartbeatAt: 0,
  };
  report.questions ||= {};
  report.heartbeatAt ||= 0;
  if (report.done) return;
  const link = readJson(path.join(root, "native-link.json"));
  const failed = readJson(path.join(root, "launch-failed.json"));
  const check = (result) => {
    if (!result.ok && !(result.data?.messageId && result.data?.timedOut))
      throw Error(
        result.data?.error?.message ||
          result.error ||
          "Orca connection interrupted",
      );
    return result.data?.result || result.data;
  };
  try {
    if (fs.existsSync(path.join(root, "connection-pause")))
      throw Error(
        "Orca transport deliberately interrupted for this owned workflow; native execution continues.",
      );
    if (Date.now() - (report.connectionCheckedAt || 0) >= 10000) {
      const connection = await runCommand(exe, ["status", "--json"], 5000);
      if (!connection.ok || connection.data?.result?.runtime?.reachable !== true)
        throw Error(
          connection.data?.error?.message ||
            connection.error ||
            `Orca runtime is unavailable (${connection.data?.result?.runtime?.state || "unknown"})`,
        );
      report.connectionCheckedAt = Date.now();
    }
    const nativeRunIds = new Set((link?.runs || []).map((run) => run.runId));
    const childDir = path.join(root, "children");
    for (const file of fs.existsSync(childDir)
      ? fs.readdirSync(childDir)
      : []) {
      if (file.startsWith("native-")) {
        const child = readJson(path.join(childDir, file));
        if (child?.runId) nativeRunIds.add(child.runId);
      }
    }
    if (link?.supervisorRoot)
      for (const name of fs.existsSync(link.supervisorRoot)
        ? fs.readdirSync(link.supervisorRoot)
        : []) {
        const requests = path.join(link.supervisorRoot, name, "requests");
        if (!fs.existsSync(requests)) continue;
        for (const file of fs
          .readdirSync(requests)
          .filter((n) => n.endsWith(".json"))) {
          const req = readJson(path.join(requests, file));
          if (
            !req ||
            !req.expectsReply ||
            !nativeRunIds.has(req.runId) ||
            (req.expiresAt && req.expiresAt < Date.now())
          )
            continue;
          const id = hash(req.id);
          // Save source question before invoking ask so a native reply cannot erase it.
          atomicJson(path.join(root, "questions", `${id}.json`), req);
        }
      }
    const questionsDir = path.join(root, "questions");
    let awaitingAnswerReceipt = false;
    for (const file of fs.existsSync(questionsDir)
      ? fs.readdirSync(questionsDir)
      : []) {
      const req = readJson(path.join(questionsDir, file));
      if (!req) continue;
      const id = hash(req.id);
      if (!report.questions[req.id]) {
        const asked = check(
          await executeOnce(
            dir,
            `question-${id}`,
            [
              "orchestration",
              "ask",
              "--question",
              `[native request ${req.id}; ${req.runId}#${req.childIndex}] ${req.message}`,
              "--timeout-ms",
              "1000",
              "--json",
            ],
            exe,
            runCommand,
          ),
        );
        if (!asked.messageId)
          throw Error("Orca question did not return its message ID");
        report.questions[req.id] = {
          messageId: asked.messageId,
          runId: req.runId,
        };
        atomicJson(path.join(root, "health.json"), report);
      }
      const answerFile = path.join(root, "answers", `${id}.json`);
      let answer = readJson(answerFile);
      const q = report.questions[req.id];
      if (!answer && link?.supervisorRoot) {
        // Recover a confirmed native reply even if its parent died before
        // mirroring the acknowledgement. Never manufacture an answer.
        const safe = (value) =>
          value
            .trim()
            .replace(/[^A-Za-z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "unknown";
        const native = readJson(
          path.join(
            link.supervisorRoot,
            `${safe(req.runId)}-${safe(req.agent)}-${req.childIndex}`,
            "replies",
            safe(req.id) + ".json",
          ),
        );
        if (
          native?.type === "subagent.supervisor.reply" &&
          native.requestId === req.id
        ) {
          answer = {
            requestId: req.id,
            message: native.message,
            confirmedBy: "subagent_supervisor",
            confirmedAt: native.createdAt,
          };
          atomicJson(answerFile, answer);
        }
      }
      if (answer?.confirmedBy === "subagent_supervisor" && !q.answered) {
        // Queue the reply in the real coordinator endpoint, not the worker.
        const input = path.join(
          mapping.coordinator.dir,
          `cmd-answer-${id}.json`,
        );
        if (!fs.existsSync(input))
          atomicJson(input, {
            args: [
              "orchestration",
              "reply",
              "--id",
              q.messageId,
              "--run",
              mapping.orcaRunId,
              "--body",
              `[native request ${req.id}] ${answer.message}`,
              "--json",
            ],
          });
        const reply = readJson(
          path.join(mapping.coordinator.dir, `reply-answer-${id}.json`),
        );
        if (reply) {
          check(reply);
          q.answered = true;
        } else awaitingAnswerReceipt = true;
      }
    }
    const current = link?.current,
      status = current
        ? readJson(path.join(current.asyncDir, "status.json"))
        : null;
    if (status && status.runId !== current.runId)
      throw Error("Native run identity mismatch; completion blocked");
    const terminal = [
      "complete",
      "completed",
      "failed",
      "partial",
      "stopped",
      "rejected",
    ].includes(status?.state);
    if (awaitingAnswerReceipt) {
      report.connected = true;
      report.phase = "waiting for confirmed Orca reply";
      report.updatedAt = Date.now();
      atomicJson(path.join(root, "health.json"), report);
      return;
    }
    delete report.phase;
    if (failed || terminal) {
      const outcome =
        !failed && ["complete", "completed"].includes(status.state)
          ? "succeeded"
          : "failed";
      const body = failed
        ? `The native workflow could not start. ${failed.error}. No native completion is claimed.`
        : `Pi completed native workflow ${current.runId}. Its terminal state is ${status.state}. ${outcome === "succeeded" ? "No native work remains." : "The requested work did not finish successfully; inspect the native result."}`;
      const result = check(
        await executeOnce(
          dir,
          "done",
          [
            "orchestration",
            "send",
            "--from",
            process.env.ORCA_TERMINAL_HANDLE || mapping.worker.terminal.handle,
            "--type",
            "worker_done",
            "--subject",
            `Pi workflow ${status?.state || "launch failed"}`,
            "--body",
            body,
            "--task-id",
            mapping.taskId,
            "--dispatch-id",
            mapping.dispatchId,
            "--outcome",
            outcome,
            ...(current
              ? ["--report-path", path.join(current.asyncDir, "status.json")]
              : []),
            "--json",
          ],
          exe,
          runCommand,
        ),
      );
      if (!["completed", "failed"].includes(result.lifecycle?.action))
        throw Error("Orca did not accept workflow completion");
      report.done = {
        outcome,
        nativeState: status?.state || "launch_failed",
        receipt: result,
      };
    } else if (link && Date.now() - report.heartbeatAt >= 240000) {
      const bucket = Math.floor(Date.now() / 240000);
      check(
        await executeOnce(
          dir,
          `heartbeat-${bucket}`,
          [
            "orchestration",
            "send",
            "--type",
            "heartbeat",
            "--subject",
            "Pi native workflow active",
            "--task-id",
            mapping.taskId,
            "--dispatch-id",
            mapping.dispatchId,
            "--phase",
            status?.state || "waiting for native status",
            "--json",
          ],
          exe,
          runCommand,
        ),
      );
      report.heartbeatAt = Date.now();
    }
    report.connected = true;
    delete report.error;
  } catch (e) {
    report.connected = false;
    report.error = e.message;
  }
  report.updatedAt = Date.now();
  try {
    atomicJson(path.join(root, "health.json"), report);
  } catch (error) {
    // A stale health report is the parent's visible warning; the loop must
    // survive a rename lock to keep serving the spool and retry next tick.
    console.error(`adapter: health report not persisted: ${error.message}`);
  }
}

async function serve(dir, exe) {
  fs.mkdirSync(dir, { recursive: true });
  // The shared writer no longer creates parent directories per call; make
  // the adapter's own dynamic subdirectory once at start.
  fs.mkdirSync(path.join(path.dirname(dir), "questions"), { recursive: true });
  let bindingId;
  console.log(
    "Pi Bots protocol adapter — no AI model. Native Pi owns the children.",
  );
  const allowed = new Set([
    "run-create",
    "run-use",
    "run-show",
    "task-create",
    "task-list",
    "dispatch",
    "dispatch-show",
    "request-show",
    "send",
    "reply",
    "check",
    "ask",
  ]);
  while (!fs.existsSync(path.join(dir, "exit"))) {
    const binding = readJson(path.join(dir, "binding.json"));
    if (binding?.id !== bindingId) {
      if (!binding?.identity?.ORCA_TERMINAL_HANDLE)
        throw Error("Adapter has no owned terminal binding.");
      for (const key of Object.keys(process.env))
        if (key.startsWith("ORCA_")) delete process.env[key];
      Object.assign(process.env, binding.env);
      bindingId = binding.id;
    }
    const identity = Object.fromEntries(
      [
        "ORCA_TERMINAL_HANDLE",
        "ORCA_PANE_KEY",
        "ORCA_TAB_ID",
        "ORCA_WORKTREE_ID",
      ].map((k) => [k, process.env[k] || null]),
    );
    try {
      atomicJson(path.join(dir, "hello.json"), {
        version: 2,
        pid: process.pid,
        identity,
        bindingId,
        updatedAt: Date.now(),
      });
    } catch (error) {
      // Liveness beacon lost: the parent sees the stale hello/health and
      // raises its visible warning. The loop keeps serving the spool.
      console.error(`adapter: hello not persisted: ${error.message}`);
    }
    for (const name of fs
      .readdirSync(dir)
      .filter((n) => /^cmd-[A-Za-z0-9-]+\.json$/.test(n))
      .sort()) {
      const input = path.join(dir, name),
        output = input.replace("cmd-", "reply-");
      if (readJson(output)?.ok) continue;
      const req = JSON.parse(fs.readFileSync(input, "utf8"));
      let result;
      if (
        !Array.isArray(req.args) ||
        req.args[0] !== "orchestration" ||
        !allowed.has(req.args[1]) ||
        !req.args.every((x) => typeof x === "string")
      ) {
        result = { ok: false, error: "Unsupported adapter command" };
      } else {
        try {
          result = await executeOnce(dir, name.slice(4, -5), req.args, exe);
        } catch (error) {
          // Targeted report: no success confirmation, no double execution.
          // When the failure reply can be persisted it reports the problem
          // and stabilizes the loop; otherwise nothing is written and the
          // operation stays unfinished — the claim, when set, makes the
          // next caller see 'uncertain' instead of a replacement start.
          console.error(
            `adapter: operation ${name.slice(4, -5)} not confirmed: ${error.message}`,
          );
          try {
            if (!fs.existsSync(output))
              atomicJson(
                output,
                error.invoked
                  ? { ok: false, uncertain: true, error: error.message }
                  : { ok: false, error: error.message },
              );
          } catch {
            // The reply itself could not be persisted; the error above is
            // the report. Nothing may be confirmed.
          }
          continue;
        }
      }
      if (!fs.existsSync(output)) {
        try {
          atomicJson(output, result);
        } catch (error) {
          console.error(
            `adapter: reply for ${name.slice(4, -5)} not persisted: ${error.message}`,
          );
        }
      }
    }
    await tickWorkflow(dir, exe);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
export function ensureBoundAdapter(dir, exe) {
  const binding = readJson(path.join(dir, "binding.json"));
  if (!binding?.identity?.ORCA_TERMINAL_HANDLE || !binding?.identity?.ORCA_PANE_KEY)
    throw Error("No original adapter terminal binding is available.");
  const claim = path.join(dir, "daemon.claim"), record = readJson(path.join(dir, "daemon.json"));
  if (record?.pid) {
    try { process.kill(record.pid, 0); return record; } catch {}
  }
  if (fs.existsSync(claim) && !record)
    throw Error("Original adapter process launch is unconfirmed; replacement blocked.");
  if (!fs.existsSync(claim)) fs.writeFileSync(claim, JSON.stringify({ at: Date.now() }), { flag: "wx" });
  const log = fs.openSync(path.join(dir, "adapter.log"), "a");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_")));
  Object.assign(env, binding.env);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dir, exe, "--daemon"], {
    cwd: process.cwd(), env, windowsHide: true, detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.closeSync(log);
  const next = { pid: child.pid, startedAt: Date.now() };
  atomicJson(path.join(dir, "daemon.json"), next);
  return next;
}

async function bootstrap(dir, exe, quiet = false) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "bootstrap.claim");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), {
    flag: "wx",
  });
  const identity = Object.fromEntries(
    [
      "ORCA_TERMINAL_HANDLE",
      "ORCA_PANE_KEY",
      "ORCA_TAB_ID",
      "ORCA_WORKTREE_ID",
    ].map((k) => [k, process.env[k] || null]),
  );
  if (!identity.ORCA_TERMINAL_HANDLE || !identity.ORCA_PANE_KEY)
    throw Error("Run the adapter in its assigned Orca terminal.");
  const previous = readJson(path.join(dir, "binding.json"));
  if (
    previous &&
    (previous.identity.ORCA_PANE_KEY !== identity.ORCA_PANE_KEY ||
      previous.identity.ORCA_TAB_ID !== identity.ORCA_TAB_ID)
  )
    throw Error(
      "The original coordinator/workflow pane is missing. Replacing its dispatch identity is blocked.",
    );
  const binding = {
    id: randomUUID(),
    identity,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith("ORCA_")),
    ),
  };
  atomicJson(path.join(dir, "binding.json"), binding);
  ensureBoundAdapter(dir, exe);
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (readJson(path.join(dir, "hello.json"))?.bindingId === binding.id) {
      fs.unlinkSync(lock);
      if (!quiet) console.log(
        "Pi Bots protocol adapter ready. No AI model.",
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(
    "Original adapter did not acknowledge its terminal binding; no additional adapter was started.",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[4] === "--daemon")
    await serve(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
  else {
    await bootstrap(
      path.resolve(process.argv[2]),
      path.resolve(process.argv[3]),
      process.argv[4] === "--shared-tui",
    );
    if (process.argv[4] === "--shared-tui") {
      const { serveDispatchTui } = await import("./dispatch-tui.mjs");
      await serveDispatchTui(path.resolve(process.argv[2]));
    }
  }
}
