import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(scriptDir, "../../..");
const extensionSource = path.join(agentRoot, "extensions", "pi-bots.ts");
const stagingPath = extensionSource;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bots-extension-test-"));
const previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_BOTS_TEST_CONTROL = tempRoot;
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;

try {

	const { default: registerExtension } = await import(`${pathToFileURL(stagingPath).href}?test=${Date.now()}`);
	const replyListeners = new Map();
	const lifecycleHandlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const visibleMessages = [];
	const heldRequests = [];
	let rpcMode = "immediate";
	let spawnNumber = 0;
	let lastRequest;

	function dispatch(request, reply) {
		for (const handler of [...(replyListeners.get(`subagents:rpc:v1:reply:${request.requestId}`) || [])]) handler(reply);
	}
	function successData(request, forcedRunId) {
		if (request.method === "spawn") {
			const runId = forcedRunId || `spawn-${++spawnNumber}`;
			return { text: "started", details: { runId, asyncDir: path.join(tempRoot, "async-subagent-runs", runId) } };
		}
		if (request.method === "resume") {
			const runId = "resumed-run";
			return { text: "resumed", details: { runId, asyncDir: path.join(tempRoot, "async-subagent-runs", runId) } };
		}
		return { text: "status ok", details: {} };
	}

	const pi = {
		events: {
			on(name, handler) {
				let listeners = replyListeners.get(name);
				if (!listeners) replyListeners.set(name, listeners = new Set());
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			emit(name, request) {
				if (name !== "subagents:rpc:v1:request") return;
				lastRequest = request;
				if (rpcMode === "hold") {
					heldRequests.push(request);
					return;
				}
				queueMicrotask(() => dispatch(request, rpcMode === "failure"
					? { version: 1, requestId: request.requestId, method: request.method, success: false, error: { code: "execution_failed", message: "smoke failure" } }
					: { version: 1, requestId: request.requestId, method: request.method, success: true, data: successData(request) }));
			},
		},
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, definition) { commands.set(name,definition); },
		on(name, handler) { lifecycleHandlers.set(name, handler); },
		sendMessage(message) { visibleMessages.push(message); },
	};
	registerExtension(pi);
	assert(commands.has('pi-bots-settings'));
	const preference = commands.get('pi-bots-settings');
	const preferenceContext = {hasUI:false,ui:{notify() {}}};
	const preferenceFile = path.join(tempRoot,'pi-bots-settings.json');
	fs.writeFileSync(preferenceFile,JSON.stringify({unrelated:{keep:42}}));
	await preference.handler('stop-on-tab-close off',preferenceContext);
	assert.equal(JSON.parse(fs.readFileSync(preferenceFile,'utf8')).piBots.stopOnTabClose,false);
	await preference.handler('stop-on-tab-close on',preferenceContext);
	assert.deepEqual(JSON.parse(fs.readFileSync(preferenceFile,'utf8')),{unrelated:{keep:42},piBots:{stopOnTabClose:true}});
	assert(tools.has("pi_bots"));
	assert(lifecycleHandlers.has("session_shutdown"));
	assert(!lifecycleHandlers.has("shutdown"));

	let tool = tools.get("pi_bots");
	const ctx = {
		cwd: "C:/work",
		hasUI: false,
		sessionManager: { getSessionId: () => "session-id", getSessionFile: () => "session-file" },
	};

	const started = await tool.execute("start", { action: "start", launch: { agent: "reviewer", task: "smoke" }, viewMode: "none" }, undefined, undefined, ctx);
	assert.equal(started.isError, undefined);
	assert.equal(lastRequest.version, 1);
	assert.equal(lastRequest.method, "spawn");
	assert.equal(lastRequest.params.async, true);
	assert.equal(lastRequest.params.cwd, "C:/work");
	assert.equal(started.details.runId, "spawn-1");
	const beforeInvalidLayout = lastRequest;
	const invalidLayout = await tool.execute("invalid-layout", {action:"start",execution:"headless",dispatchView:"shared",launch:{agent:"scout",task:"must not start"}},undefined,undefined,ctx);
	assert.equal(invalidLayout.isError,true);
	assert.equal(lastRequest,beforeInvalidLayout);

	const resumed = await tool.execute("resume", { action: "resume", runId: "spawn-1", message: "continue" }, undefined, undefined, ctx);
	assert.equal(resumed.isError, undefined);
	assert.equal(resumed.details.runId, "resumed-run");
	assert.equal(resumed.details.views.viewMode, "none");
	await tool.execute("steer",{action:"steer",runId:"spawn-1",message:"adjust",mode:"steer"},undefined,undefined,ctx);
	assert.equal(lastRequest.method,"steer");assert.equal(lastRequest.params.mode,"steer");
	await tool.execute("interrupt",{action:"interrupt",runId:"spawn-1",index:2},undefined,undefined,ctx);
	assert.equal(lastRequest.method,"interrupt");assert.equal(lastRequest.params.index,2);
	await tool.execute("stop",{action:"stop",runId:"spawn-1",childId:"stable-child"},undefined,undefined,ctx);
	assert.equal(lastRequest.method,"stop");assert.equal(lastRequest.params.childId,"stable-child");

	rpcMode = "failure";
	const failed = await tool.execute("failure", { action: "status", runId: "spawn-1" }, undefined, undefined, ctx);
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /execution_failed: smoke failure/);

	rpcMode = "hold";
	const controller = new AbortController();
	const uncertainPromise = tool.execute("uncertain", { action: "start", launch: { agent: "worker", task: "late" }, viewMode: "none" }, controller.signal, undefined, ctx);
	controller.abort();
	const uncertain = await uncertainPromise;
	assert.equal(uncertain.isError, true);
	assert.match(uncertain.content[0].text, /request aborted/);
	const blockedRetry = await tool.execute("blocked", { action: "start", launch: { agent: "worker", task: "duplicate" }, viewMode: "none" }, undefined, undefined, ctx);
	assert.equal(blockedRetry.isError, true);
	assert.match(blockedRetry.content[0].text, /Retry is blocked/);
	assert.equal(heldRequests.length, 1);
	const lateRequest = heldRequests.shift();
	dispatch(lateRequest, { version: 1, requestId: lateRequest.requestId, method: "spawn", success: true, data: successData(lateRequest, "late-run") });
	await new Promise((resolve) => setImmediate(resolve));
	assert(visibleMessages.some((message) => /late-run/.test(message.content)));
	rpcMode = "immediate";
	const safeRetry = await tool.execute("safe-retry", { action: "start", launch: { agent: "worker", task: "safe" }, viewMode: "none" }, undefined, undefined, ctx);
	assert.equal(safeRetry.isError, undefined);

	// Resume has the same detached lifetime as spawn; cancellation is not a stop.
	rpcMode = "hold";
	const resumeAbort = new AbortController();
	const pendingResume = tool.execute("cancel-resume", {action:"resume",runId:"late-run",message:"continue"}, resumeAbort.signal, undefined, ctx);
	resumeAbort.abort();
	assert.equal((await pendingResume).isError,true);
	assert.equal((await tool.execute("duplicate-resume",{action:"resume",runId:"late-run",message:"again"},undefined,undefined,ctx)).isError,true);
	assert.equal(heldRequests.length,1);
	const resumeRequest=heldRequests.shift();
	assert.equal(resumeRequest.method,"resume");
	// Invalid envelopes cannot consume the valid late receipt.
	dispatch(resumeRequest,{version:1,requestId:"wrong-id",success:true,data:successData(resumeRequest)});
	assert.equal((await tool.execute("still-blocked",{action:"start",launch:{agent:"scout",task:"duplicate"},viewMode:"none"},undefined,undefined,ctx)).isError,true);
	// Simulate reload while the original native invocation is still pending.
	lifecycleHandlers.get("session_shutdown")();
	registerExtension(pi);
	const restoredTool=tools.get("pi_bots");
	tool=restoredTool;
	lifecycleHandlers.get("session_start")({},ctx);
	assert.equal((await restoredTool.execute("reload-block",{action:"start",launch:{agent:"scout",task:"duplicate"},viewMode:"none"},undefined,undefined,ctx)).isError,true);
	dispatch(resumeRequest,{version:1,requestId:resumeRequest.requestId,success:true,data:successData(resumeRequest)});
	rpcMode="immediate";
	assert.equal((await restoredTool.execute("restored",{action:"status",runId:"resumed-run"},undefined,undefined,ctx)).isError,undefined);

	const asyncDir = path.join(tempRoot, "async-subagent-runs", "supervised-run");
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "supervised-run", state: "running", steps: [{ agent: "worker", status: "running" }] }));
	const channel = path.join(tempRoot, "supervisor-channels", "supervised-run-worker-0");
	fs.mkdirSync(path.join(channel, "requests"), { recursive: true });
	const request = {
		type: "subagent.supervisor.request", id: "request-1", createdAt: Date.now(), expiresAt: Date.now() + 60000,
		reason: "need_decision", message: "Choose", expectsReply: true, orchestratorSessionId: "session-file",
		runId: "supervised-run", agent: "worker", childIndex: 0,
	};
	fs.writeFileSync(path.join(channel, "requests", "request-1.json"), JSON.stringify(request));
	const pending = await tool.execute("pending", { action: "supervisor_pending" }, undefined, undefined, ctx);
	assert.equal(pending.details.pending.length, 1);
	const replied = await tool.execute("reply", { action: "supervisor_reply", replyTo: "request-1", message: "Proceed" }, undefined, undefined, ctx);
	assert.equal(replied.isError, undefined);
	assert(fs.existsSync(path.join(channel, "replies", "request-1.json")));

	const foregroundChannel = path.join(tempRoot, "supervisor-channels", "foreground-worker-0");
	fs.mkdirSync(path.join(foregroundChannel, "requests"), { recursive: true });
	fs.writeFileSync(path.join(foregroundChannel, "requests", "request-2.json"), JSON.stringify({ ...request, id: "request-2", runId: "foreground" }));
	const hiddenForeground = await tool.execute("foreground", { action: "supervisor_pending" }, undefined, undefined, ctx);
	assert.equal(hiddenForeground.details.pending.length, 0);

	lifecycleHandlers.get("session_shutdown")();

	// Status wave dedupe + early child failure (create-beta POS fix): a
	// running orca-tui child whose TUI state does not change must produce
	// exactly one wave message, and a host failure must surface once as a
	// compact child-failure message while the workflow still runs.
	{
		const { createHash } = await import("node:crypto");
		const waveSessionKey = "session-id-wave";
		const waveCtx = { ...ctx, sessionManager: { getSessionId: () => waveSessionKey, getSessionFile: () => "session-file-wave" } };
		const tuiRunId = "tui-wave-run";
		const tuiAsyncDir = path.join(tempRoot, "async-subagent-runs", tuiRunId);
		const hostFile = path.join(tuiAsyncDir, "tui", "0-attempt", "host.json");
		fs.mkdirSync(path.dirname(hostFile), { recursive: true });
		const writeHost = (host) => fs.writeFileSync(hostFile, JSON.stringify(host));
		writeHost({ runId: "native-1", index: 0, state: "ready", viewState: "attached", sessionId: "sess-abc", view: { handle: "h1", tabId: "t1", paneKey: "t1:p1" } });
		fs.writeFileSync(path.join(tuiAsyncDir, "status.json"), JSON.stringify({ runId: tuiRunId, state: "running", steps: [{ agent: "worker", runId: "native-1", sessionFile: "native-1-file" }] }));
		fs.writeFileSync(path.join(tuiAsyncDir, "tui", "child-0.json"), JSON.stringify({ manifest: hostFile }));
		const digest = createHash("sha256").update(waveSessionKey).digest("hex");
		const journalDir = path.join(tempRoot, "pi-bots-state", digest);
		fs.mkdirSync(journalDir, { recursive: true });
		fs.writeFileSync(path.join(journalDir, "journal.json"), JSON.stringify({
			version: 1, sessionKey: waveSessionKey, operations: {},
			runs: [{ runId: tuiRunId, asyncDir: tuiAsyncDir, viewMode: "orca", titlePrefix: "Wave", active: true, execution: "orca-tui", published: [], attempts: [] }],
		}));
		lifecycleHandlers.get("session_start")({}, waveCtx);
		const waveCount = () => visibleMessages.filter((m) => m.customType === "pi_bots_view_wave" && String(m.content).includes(tuiRunId)).length;
		const failureCount = () => visibleMessages.filter((m) => m.customType === "pi_bots_child_failed" && String(m.content).includes(tuiRunId)).length;
		const waitForWaves = async (expected, ms) => {
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				if (waveCount() >= expected) return true;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			return waveCount() >= expected;
		};
		assert(await waitForWaves(1, 5000), "the first wave is published");
		await new Promise((resolve) => setTimeout(resolve, 2200));
		assert.equal(waveCount(), 1, "unchanged TUI state must not republish the wave");
		assert.equal(failureCount(), 0);
		writeHost({ runId: "native-1", index: 0, state: "failed", viewState: "detached", sessionId: "sess-abc", view: { handle: "h1", tabId: "t1", paneKey: "t1:p1" }, error: "EPERM: operation not permitted, rename C:\\x\\host.json.1.tmp -> C:\\x\\host.json\n    at save (broker)\n    at processTicksAndRejections" });
		assert(await waitForWaves(2, 5000), "the state change republishes the wave");
		const failureDeadline = Date.now() + 5000;
		while (Date.now() < failureDeadline && failureCount() < 1)
			await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(failureCount(), 1, "a failed child is surfaced exactly once");
		const failureMessage = visibleMessages.filter((m) => m.customType === "pi_bots_child_failed").at(-1);
		assert.match(String(failureMessage.content), /Child 0/);
		assert.match(String(failureMessage.content), /EPERM: operation not permitted, rename/);
		assert.doesNotMatch(String(failureMessage.content), /at save \(broker\)/, "stack traces stay in the diagnostics");
		assert.match(String(failureMessage.content), /0\/1 children without error/);
		await new Promise((resolve) => setTimeout(resolve, 2200));
		assert.equal(waveCount(), 2, "the failure wave is not repeated");
		assert.equal(failureCount(), 1, "the failure message is not repeated");
	}

	lifecycleHandlers.get("session_shutdown")();
	console.log("PASS: Pi Bots native RPC controls, cancelled spawn/resume, reload with late receipt, supervisor scope, status dedupe, early child failure, and lifecycle tests");
} finally {
	/* Source stays in place. */
	fs.rmSync(tempRoot, { recursive: true, force: true });
	if (previousTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
}
