// POS reference workflow template: control-flow tests through the real
// workflow sandbox with stubbed native children. Covers direct success, one
// fix round, the round limit, infrastructure errors, reuse of finished
// results, visible reuse blocks (invalid reference, transport error, running
// writer, failed run), and missing optional result fields.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflowScript, validateWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

const templatePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../skills/pos/templates/scout-worker-review.mjs",
);
const templateSource = fs.readFileSync(templatePath, "utf8");

const okChild = (key, extra = {}) => ({ key, ok: true, output: "ok", artifactPaths: [], runId: "run-" + key, ...extra });
const failedChild = (key, error) => ({ key, ok: false, output: "", error, artifactPaths: [] });
// The native status action reports "State: <state>" in its text; reuse is
// only honored for a finished successful run ("State: complete").
const finishedStatus = (id) => ({ key: id, ok: true, runId: id, artifactPaths: [], output: "Run: " + id + "\nState: complete\nProgress: done" });

const approved = { verdict: "approved", findings: [], checked: ["focused validation"] };
const changesRequired = {
  verdict: "changes_required",
  findings: [{ severity: "blocker", title: "Broken assertion", detail: "Test X fails on the changed line", evidence: "log line 3" }],
  checked: ["tests"],
};

function makeHarness({ launchPlan = {}, statusPlan = {}, script = templateSource } = {}) {
  const launches = [];
  const launch = async (key, params) => {
    launches.push({ key, params });
    const planned = launchPlan[key];
    if (planned) return planned;
    return okChild(key);
  };
  const statusCalls = [];
  const status = async (reference) => {
    statusCalls.push(reference);
    const planned = statusPlan[reference];
    if (typeof planned === "function") return planned(reference);
    if (!planned) throw new Error("no such run: " + reference);
    return planned;
  };
  return {
    launches,
    statusCalls,
    execute: () => runWorkflowScript({ script, launch, status, timeoutMs: 30000 }),
  };
}

test("the template is a valid workflow script for the native sandbox", () => {
  const validation = validateWorkflowScript(templateSource);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
});

test("direct success: one review round, no fix", async () => {
  const { launches, execute } = makeHarness({ launchPlan: { "review-1": okChild("review-1", { structuredOutput: approved }) } });
  const result = await execute();
  assert.equal(result.value.status, "complete");
  assert.equal(result.value.verdict, "approved");
  assert.equal(result.value.rounds, 1);
  assert.deepEqual(launches.map((l) => l.key), ["scout", "implement", "review-1"]);
  const reviewLaunch = launches.find((l) => l.key === "review-1");
  assert.equal(reviewLaunch.params.context, "fresh");
  assert.deepEqual(reviewLaunch.params.outputSchema.properties.verdict.enum, ["approved", "changes_required"]);
});

test("one fix round: changes required, then approved", async () => {
  const { launches, execute } = makeHarness({
    launchPlan: {
      "review-1": okChild("review-1", { structuredOutput: changesRequired }),
      "review-2": okChild("review-2", { structuredOutput: approved }),
    },
  });
  const result = await execute();
  assert.equal(result.value.status, "complete");
  assert.equal(result.value.rounds, 2);
  assert.deepEqual(launches.map((l) => l.key), ["scout", "implement", "review-1", "fix-1", "review-2"]);
  const fixTask = launches.find((l) => l.key === "fix-1").params.task;
  assert.match(fixTask, /Broken assertion/);
  assert.match(fixTask, /changes_required/);
  // The fix round is a domain finding, not an execution failure: the result
  // is a normal complete workflow.
  assert.equal(result.value.reviews[0].blockers, 1);
});

test("round limit: three reviews, no fix after the last round", async () => {
  const { launches, execute } = makeHarness({
    launchPlan: {
      "review-1": okChild("review-1", { structuredOutput: changesRequired }),
      "review-2": okChild("review-2", { structuredOutput: changesRequired }),
      "review-3": okChild("review-3", { structuredOutput: changesRequired }),
    },
  });
  const result = await execute();
  assert.equal(result.value.status, "changes_required_after_limit");
  assert.equal(result.value.verdict, "changes_required");
  assert.equal(result.value.rounds, 3);
  assert.deepEqual(launches.map((l) => l.key), ["scout", "implement", "review-1", "fix-1", "review-2", "fix-2", "review-3"]);
  assert.equal(launches.some((l) => l.key === "fix-3"), false);
  assert.match(result.value.note, /changes required/i);
});

test("infrastructure error: failed implementation stops the review loop", async () => {
  const { launches, execute } = makeHarness({ launchPlan: { implement: failedChild("implement", "child process exited with error") } });
  const result = await execute();
  assert.equal(result.value.status, "infrastructure_error");
  assert.equal(result.value.failedStep, "implementation");
  assert.deepEqual(launches.map((l) => l.key), ["scout", "implement"]);
});

test("infrastructure error: failed review stops without a fix round", async () => {
  const { launches, execute } = makeHarness({ launchPlan: { "review-1": failedChild("review-1", "structured output missing") } });
  const result = await execute();
  assert.equal(result.value.status, "infrastructure_error");
  assert.equal(result.value.failedStep, "review-1");
  assert.deepEqual(launches.map((l) => l.key), ["scout", "implement", "review-1"]);
});

test("finished results are reused through run references", async () => {
  const script = templateSource
    .replace("scoutRunId: undefined,", 'scoutRunId: "scout-done-1",')
    .replace("implementationRunId: undefined,", 'implementationRunId: "impl-done-1",');
  const { launches, statusCalls, execute } = makeHarness({
    script,
    statusPlan: {
      "scout-done-1": finishedStatus("scout-done-1"),
      "impl-done-1": finishedStatus("impl-done-1"),
    },
    launchPlan: { "review-1": okChild("review-1", { structuredOutput: approved }) },
  });
  const result = await execute();
  assert.equal(result.value.status, "complete");
  assert.deepEqual(launches.map((l) => l.key), ["review-1"]);
  assert.deepEqual(statusCalls, ["scout-done-1", "impl-done-1"]);
  assert.deepEqual(result.value.reused, ["scout:scout-done-1", "implementation:impl-done-1"]);
});

test("an invalid reuse reference stops visibly and preserves the reference (no replacement run)", async () => {
  const script = templateSource.replace("scoutRunId: undefined,", 'scoutRunId: "missing-run-1",');
  const { launches, execute } = makeHarness({ script });
  const result = await execute();
  assert.equal(result.value.status, "reuse_blocked");
  assert.equal(result.value.failedStep, "scout-reuse");
  assert.equal(result.value.reference, "missing-run-1");
  assert.match(result.value.error, /no such run: missing-run-1/);
  assert.match(result.value.note, /no replacement run was started/);
  assert.deepEqual(launches, [], "no replacement scout, no implementation, no review");
});

test("a status transport error stops visibly (no replacement run)", async () => {
  const script = templateSource.replace("implementationRunId: undefined,", 'implementationRunId: "flaky-status-1",');
  const { launches, execute } = makeHarness({
    script,
    statusPlan: {
      "flaky-status-1": () => {
        throw new Error("status endpoint unavailable (injected transport failure)");
      },
    },
  });
  const result = await execute();
  assert.equal(result.value.status, "reuse_blocked");
  assert.equal(result.value.failedStep, "implementation-reuse");
  assert.equal(result.value.reference, "flaky-status-1");
  assert.match(result.value.error, /status endpoint unavailable/);
  assert.deepEqual(
    launches.map((l) => l.key),
    ["scout"],
    "no replacement implementation, no review",
  );
});

test("a running writer reference stops visibly without a replacement writer", async () => {
  const script = templateSource.replace("implementationRunId: undefined,", 'implementationRunId: "writer-running-1",');
  const { launches, execute } = makeHarness({
    script,
    statusPlan: {
      "writer-running-1": { key: "writer-running-1", ok: true, runId: "writer-running-1", artifactPaths: [], output: "Run: writer-running-1\nState: running\nActivity: tool call 3" },
    },
  });
  const result = await execute();
  assert.equal(result.value.status, "reuse_blocked");
  assert.equal(result.value.failedStep, "implementation-reuse");
  assert.equal(result.value.observedState, "running");
  assert.equal(result.value.reference, "writer-running-1");
  assert.deepEqual(
    launches.map((l) => l.key),
    ["scout"],
    "a second writer for the workspace is blocked",
  );
});

test("a failed referenced run stops visibly instead of being reused or replaced", async () => {
  const script = templateSource.replace("scoutRunId: undefined,", 'scoutRunId: "scout-failed-1",');
  const { launches, execute } = makeHarness({
    script,
    statusPlan: {
      "scout-failed-1": { key: "scout-failed-1", ok: true, runId: "scout-failed-1", artifactPaths: [], output: "Run: scout-failed-1\nState: failed\nError: child process exited with error" },
    },
  });
  const result = await execute();
  assert.equal(result.value.status, "reuse_blocked");
  assert.equal(result.value.failedStep, "scout-reuse");
  assert.equal(result.value.observedState, "failed");
  assert.equal(result.value.reference, "scout-failed-1");
  assert.deepEqual(launches, [], "no fresh run is started for a failed reference");
});

test("missing optional result fields do not abort the workflow", async () => {
  const { execute } = makeHarness({
    // No findings, no checked, no evidence: only the verdict drives the loop.
    launchPlan: { "review-1": okChild("review-1", { structuredOutput: { verdict: "approved" } }) },
  });
  const result = await execute();
  assert.equal(result.value.status, "complete");
  assert.equal(result.value.rounds, 1);
});

// E2.4: a valid structured result plus additionally required artifacts must
// carry the output contract in the executable workflow result (not only in
// Markdown instructions): the structured result exists, the required files
// are named, and the exact report string for a missing file is provided.
// The child execution itself stays successful; the parent verifies the
// files (the sandbox has no filesystem access).
test("a valid structured result carries the output contract for required artifacts", async () => {
  const script = templateSource.replace(
    "requiredArtifacts: [],",
    'requiredArtifacts: ["review-report.md"],',
  );
  const { execute } = makeHarness({
    script,
    launchPlan: { "review-1": okChild("review-1", { structuredOutput: approved }) },
  });
  const result = await execute();
  // Technically successful execution (the review was delivered).
  assert.equal(result.value.status, "complete");
  // The contract is machine-readable in the workflow result itself.
  assert.equal(result.value.outputContract.structuredResult, "exists");
  assert.deepEqual(result.value.outputContract.requiredArtifacts, ["review-report.md"]);
  assert.equal(
    result.value.outputContract.missingArtifactReport,
    "Output contract not fulfilled; structured result exists.",
  );
  assert.equal(result.value.outputContract.verification, "parent");
  assert.deepEqual(result.value.requiredArtifacts, ["review-report.md"]);
});

test("a technically negative (round-limited) result also carries the output contract", async () => {
  const { execute } = makeHarness({
    launchPlan: {
      "review-1": okChild("review-1", { structuredOutput: changesRequired }),
      "review-2": okChild("review-2", { structuredOutput: changesRequired }),
      "review-3": okChild("review-3", { structuredOutput: changesRequired }),
    },
  });
  const result = await execute();
  assert.equal(result.value.status, "changes_required_after_limit");
  assert.equal(result.value.outputContract.structuredResult, "exists");
  assert.equal(
    result.value.outputContract.missingArtifactReport,
    "Output contract not fulfilled; structured result exists.",
  );
});
