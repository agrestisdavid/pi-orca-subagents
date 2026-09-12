import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prepareWorkflow, attachNative, captureNativeQuestion, confirmNativeReply, failBeforeNative, bridgeStatus } from "../skills/pos/scripts/orca-bridge.mjs";
import {nativeTuiChildren,cleanupTuiViews} from "../skills/pos/scripts/tui-views.mjs";
import {settingsFile,stopOnTabClose,saveStopOnTabClose} from "../skills/pos/scripts/settings.mjs";

import { resolveTuiResources } from '../src/pos/resources.mjs';

const RPC_VERSION = 1;
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const TERMINAL_STATES = new Set(["complete", "completed", "failed", "partial", "stopped", "rejected"]);
const MAX_RPC_WAIT_MS = 90_000;
const MAX_SCRIPT_WAIT_MS = 90_000;
const VIEW_MONITOR_MS = 1_000;
const MAX_PUBLISH_ATTEMPTS = 3;
const DEFAULT_SUPERVISOR_ASK_TIMEOUT_MS = 10 * 60 * 1000;

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PI_BOTS_SCRIPT_DIR = path.resolve(EXTENSION_DIR, "..", "skills", "pos", "scripts");
const PUBLISH_SCRIPT = path.join(PI_BOTS_SCRIPT_DIR, "Publish-PiBotView.ps1");
const CLOSE_SCRIPT = path.join(PI_BOTS_SCRIPT_DIR, "Close-PiBotViews.ps1");

const PiBotsParams = Type.Object({
	action: Type.String({
		enum: [
			"start",
			"status",
			"steer",
			"interrupt",
			"stop",
			"resume",
			"supervisor_pending",
			"supervisor_reply",
			"sync_views",
			"cleanup_preflight",
			"cleanup_views",
		],
		description: "Pi Bots operation.",
	}),
	launch: Type.Optional(Type.Unsafe<Record<string, unknown>>({
		type: "object",
		additionalProperties: true,
		description: "For start: native pi-subagents launch parameters (agent/task or workflowScript/workflowScriptPath). async is forced true.",
	})),
	runId: Type.Optional(Type.String({ description: "Async pi-subagents run ID." })),
	asyncDir: Type.Optional(Type.String({ description: "Absolute async run directory; normally discovered automatically." })),
	childId: Type.Optional(Type.String({ description: "Stable child ID for a child-scoped stop." })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Child index for status/interrupt targeting." })),
	message: Type.Optional(Type.String({ description: "Steering, resume, or supervisor-reply message." })),
	mode: Type.Optional(Type.String({ enum: ["steer", "follow_up", "auto"], description: "Steering delivery mode." })),
	replyTo: Type.Optional(Type.String({ description: "Exact supervisor request ID." })),
	viewMode: Type.Optional(Type.String({ enum: ["both", "orca", "herdr", "none"], description: "External views; start defaults to both. orca-tui uses an interactive Pi terminal; Herdr and headless views read files." })),
	coordination: Type.Optional(Type.String({ enum: ["native", "orca"], description: "native (default), or one real Orca Task/Dispatch for this native workflow. Orca must be reachable before launch." })),
	execution: Type.Optional(Type.String({enum: ["headless", "orca-tui"], description: "headless (compatible default), or the same native child in an actual interactive Pi TUI. orca-tui requires coordination:orca and the local child-execution backend."})),
	dispatchView: Type.Optional(Type.String({enum: ["shared", "separate"], description: "orca-tui layout. Default shared: use the assigned dispatch tab for the child; children without a free dispatch tab get one new Pi tab. The invoking Orca parent coordinates without an extra adapter tab."})),
	titlePrefix: Type.Optional(Type.String({ description: "Optional view title prefix." })),
	output: Type.Optional(Type.String({ description: "Resume output file path (file-only)." })),
	confirm: Type.Optional(Type.Boolean({ description: "Required for cleanup_views only when no interactive UI is available." })),
}, { additionalProperties: false });

type ViewMode = "both" | "orca" | "herdr" | "none";
type JsonRecord = Record<string, unknown>;

interface RpcReply {
	version?: number;
	requestId?: string;
	success?: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

interface RpcCallOptions {
	requestId?: string;
	onReceipt?: (reply: RpcReply) => void;
	retainAfterCancellation?: boolean;
	onUncertain?: (requestId: string) => void;
	onLateReply?: (reply: RpcReply) => void;
}

interface TrackedRun {
	execution?: "headless" | "orca-tui";
	coordinationRoot?: string;
	runId: string;
	asyncDir: string;
	viewMode: ViewMode;
	titlePrefix: string;
	active: boolean;
	published: Set<number>;
	publishing: Set<number>;
	attempts: Map<number, number>;
	lastError?: string;
	lastCoordinationError?: string;
	lastWaveSignature?: string;
	lastFailureSignature?: string;
	syncMissing?: boolean;
	syncPromise?: Promise<JsonRecord>;
}

interface SupervisorRequest extends JsonRecord {
	type: "subagent.supervisor.request";
	id: string;
	createdAt: number;
	expiresAt?: number;
	reason: "need_decision" | "interview_request" | "progress_update";
	message: string;
	expectsReply: boolean;
	orchestratorSessionId?: string;
	runId: string;
	agent: string;
	childIndex: number;
	interview?: unknown;
	_channelDir: string;
	_requestFile: string;
}

interface ScriptResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	json?: JsonRecord;
	executable?: string;
	error?: string;
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textResult(text: string, details: JsonRecord = {}, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function extractDetails(data: unknown): JsonRecord | undefined {
	return isRecord(data) && isRecord(data.details) ? data.details : undefined;
}

function extractRunLocation(data: unknown): { runId?: string; asyncDir?: string } {
	const details = extractDetails(data);
	const runId = typeof details?.runId === "string"
		? details.runId
		: typeof details?.asyncId === "string"
			? details.asyncId
			: isRecord(data) && typeof data.runId === "string"
				? data.runId
				: undefined;
	const asyncDir = typeof details?.asyncDir === "string"
		? details.asyncDir
		: isRecord(data) && typeof data.asyncDir === "string"
			? data.asyncDir
			: undefined;
	return { runId, asyncDir };
}

function rpcText(data: unknown): string {
	if (isRecord(data) && typeof data.text === "string" && data.text.trim()) return data.text;
	return JSON.stringify(data, null, 2);
}

function currentSessionIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	try {
		const id = ctx.sessionManager.getSessionId();
		if (id) ids.add(id);
	} catch {}
	try {
		const file = ctx.sessionManager.getSessionFile();
		if (file) ids.add(file);
	} catch {}
	return ids;
}

function tempScopeId(): string {
	const clean = (value: string) => value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
	if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
	for (const key of ["USERNAME", "USER", "LOGNAME"]) {
		const value = process.env[key];
		if (value) return `user-${clean(value)}`;
	}
	try {
		const username = os.userInfo().username;
		if (username) return `user-${clean(username)}`;
	} catch {}
	return `home-${clean(os.homedir())}`;
}

function piSubagentsTempRoot(): string {
	return process.env.PI_SUBAGENTS_TEMP_ROOT?.trim() || path.join(os.tmpdir(), `pi-subagents-${tempScopeId()}`);
}

function supervisorRoot(): string {
	return path.join(piSubagentsTempRoot(), "supervisor-channels");
}

function defaultAsyncDir(runId: string): string {
	return path.join(piSubagentsTempRoot(), "async-subagent-runs", runId);
}

function validRunId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function cleanTitle(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function stepTitle(run: TrackedRun, step: JsonRecord, index: number): string {
	const agent = typeof step.agent === "string" && step.agent.trim() ? step.agent.trim() : `child-${index}`;
	const label = typeof step.label === "string" && step.label.trim() ? ` · ${step.label.trim()}` : "";
	return cleanTitle(`${run.titlePrefix} ${agent}${label}`);
}

function parseLastJsonObject(text: string): JsonRecord | undefined {
	const trimmed = text.replace(/^\uFEFF/, "").trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : undefined;
	} catch {}
	const lines = trimmed.split(/\r?\n/);
	for (let start = lines.length - 1; start >= 0; start--) {
		const candidate = lines.slice(start).join("\n").trim();
		if (!candidate.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (isRecord(parsed)) return parsed;
		} catch {}
	}
	return undefined;
}

function runWithExecutable(executable: string, script: string, args: string[], signal?: AbortSignal): Promise<ScriptResult> {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const child = spawn(executable, [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			script,
			...args,
		], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (result: ScriptResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => {
			try { child.kill(); } catch {}
			finish({ exitCode: null, stdout, stderr, executable, error: "PowerShell operation aborted." });
		};
		const timer = setTimeout(() => {
			try { child.kill(); } catch {}
			finish({ exitCode: null, stdout, stderr, executable, error: `PowerShell operation timed out after ${MAX_SCRIPT_WAIT_MS} ms.` });
		}, MAX_SCRIPT_WAIT_MS);
		timer.unref?.();
		child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", (error) => finish({ exitCode: null, stdout, stderr, executable, error: errorMessage(error) }));
		child.on("close", (exitCode) => finish({ exitCode, stdout, stderr, executable, json: parseLastJsonObject(stdout) }));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function trustedPowerShellCandidates(): string[] {
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || "C:\\Windows";
		const programFiles = process.env.ProgramFiles?.trim() || "C:\\Program Files";
		return [
			path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
		];
	}
	return ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/microsoft/powershell/7/pwsh", "/usr/bin/powershell"];
}

async function runPowerShell(script: string, args: string[], signal?: AbortSignal): Promise<ScriptResult> {
	if (!fs.existsSync(script)) {
		return { exitCode: null, stdout: "", stderr: "", error: `Pi Bots script not found: ${script}` };
	}
	const candidates = trustedPowerShellCandidates().filter((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate));
	if (candidates.length === 0) {
		return { exitCode: null, stdout: "", stderr: "", error: "No trusted absolute PowerShell executable is available." };
	}
	let last: ScriptResult | undefined;
	for (const executable of candidates) {
		const result = await runWithExecutable(executable, script, args, signal);
		last = result;
		if (signal?.aborted || result.error?.includes("timed out")) return result;
		if (result.exitCode !== null || !result.error) return result;
	}
	return last ?? { exitCode: null, stdout: "", stderr: "", error: "No trusted absolute PowerShell executable is available." };
}

function publishArgs(run: TrackedRun, index: number, title: string): string[] {
	const args = ["-RunId", run.runId, "-AsyncDir", run.asyncDir, "-ChildIndex", String(index), "-Title", title];
	if (run.viewMode === "orca") args.push("-NoHerdr");
	if (run.viewMode === "herdr") args.push("-NoOrca");
	if (run.syncMissing) args.push("-SyncMissing");
	return args;
}

function readStatus(run: TrackedRun): JsonRecord | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(run.asyncDir, "status.json"), "utf8"));
		if (!isRecord(parsed) || parsed.runId !== run.runId) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

async function publishStep(run: TrackedRun, step: JsonRecord, index: number, signal?: AbortSignal): Promise<ScriptResult> {
	if (run.published.has(index) || run.publishing.has(index)) {
		return { exitCode: 0, stdout: "", stderr: "", json: { skipped: true } };
	}
	const attempts = run.attempts.get(index) ?? 0;
	if (attempts >= MAX_PUBLISH_ATTEMPTS) {
		return { exitCode: null, stdout: "", stderr: "", error: `Publication attempt limit reached for child ${index}.` };
	}
	run.publishing.add(index);
	run.attempts.set(index, attempts + 1);
	try {
		const result = await runPowerShell(PUBLISH_SCRIPT, publishArgs(run, index, stepTitle(run, step, index)), signal);
		if (result.exitCode === 0 && result.json?.ok !== false) {
			run.published.add(index);
			run.lastError = undefined;
		} else {
			run.lastError = result.error || result.stderr.trim() || result.stdout.trim() || `Publication failed with exit code ${result.exitCode}.`;
		}
		return result;
	} finally {
		run.publishing.delete(index);
	}
}

async function syncTrackedRun(run: TrackedRun, signal?: AbortSignal): Promise<JsonRecord> {
	if (run.syncPromise) return run.syncPromise;
	const pending = syncRunOnce(run, signal);
	run.syncPromise = pending;
	try { return await pending; }
	finally { if (run.syncPromise === pending) run.syncPromise = undefined; }
}

async function syncRunOnce(run: TrackedRun, signal?: AbortSignal): Promise<JsonRecord> {
	const status = readStatus(run);
	if (status && TERMINAL_STATES.has(String(status.state))) run.active = false;
	if (run.viewMode === "none") return { runId: run.runId, viewMode: "none", state: status?.state, published: [], ...(run.coordinationRoot ? { coordination: bridgeStatus(run.coordinationRoot) } : {}) };
	if (!status) return { runId: run.runId, waitingForStatus: true, published: [...run.published], ...(run.coordinationRoot ? { coordination: bridgeStatus(run.coordinationRoot) } : {}) };
	if (run.execution === "orca-tui") {
		const {syncTuiViews} = await import("../skills/pos/scripts/tui-views.mjs");
		return await syncTuiViews(run, status, signal);
	}
	const steps = Array.isArray(status.steps) ? status.steps : [];
	const results: JsonRecord[] = [];
	for (let index = 0; index < steps.length; index++) {
		if (signal?.aborted) break;
		const step = isRecord(steps[index]) ? steps[index] as JsonRecord : {};
		if (run.published.has(index)) continue;
		const result = await publishStep(run, step, index, signal);
		results.push({ index, exitCode: result.exitCode, json: result.json, error: result.error, stderr: result.stderr.trim() || undefined });
	}
	const state = typeof status.state === "string" ? status.state : "unknown";
	if (TERMINAL_STATES.has(state)) run.active = false;
	return {
		runId: run.runId,
		state,
		stepCount: steps.length,
		published: [...run.published].sort((a, b) => a - b),
		attempts: Object.fromEntries(run.attempts),
		results,
		...(run.lastError ? { lastError: run.lastError } : {}),
		...(run.coordinationRoot ? { coordination: bridgeStatus(run.coordinationRoot) } : {}),
	};
}

function formatViewSync(views: JsonRecord): string {
	const coordination = views.coordination as any;
	const bridgeText = coordination ? `\nOrca Task ${coordination.taskId}; Dispatch ${coordination.dispatchId}: ${coordination.health?.done ? coordination.health.done.outcome : coordination.health?.connected ? "connected" : coordination.health?.error || "awaiting adapter"}. Native Pi retains process control.` : "";
	if (views.viewMode === "none") return "Spectator tabs disabled for this run." + bridgeText;
	if (views.waitingForStatus === true) return "Native run started; view synchronization is waiting for status.json." + bridgeText;
	const lines = [`Native run ${String(views.runId ?? "unknown")} state: ${String(views.state ?? "unknown")}.`];
	const results = Array.isArray(views.results) ? views.results : [];
	for (const value of results) {
		if (!isRecord(value)) continue;
		const report = isRecord(value.json) ? value.json : undefined;
		const outcome = typeof report?.summary === "string"
			? report.summary
			: typeof value.error === "string"
				? value.error
				: typeof value.stderr === "string"
					? value.stderr
					: `exit ${String(value.exitCode)}`;
		lines.push(`Child ${String(value.index)}: ${outcome}`);
	}
	if (results.length === 0) lines.push("No new views were published in this synchronization wave.");
	return lines.join("\n") + bridgeText;
}

function parseSupervisorRequest(file: string, channelDir: string): SupervisorRequest | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(value) || value.type !== "subagent.supervisor.request") return undefined;
		if (typeof value.id !== "string" || !value.id || typeof value.runId !== "string" || typeof value.agent !== "string") return undefined;
		if (typeof value.childIndex !== "number" || typeof value.createdAt !== "number" || typeof value.message !== "string" || !value.message) return undefined;
		if (value.reason !== "need_decision" && value.reason !== "interview_request" && value.reason !== "progress_update") return undefined;
		if (typeof value.expectsReply !== "boolean") return undefined;
		return { ...value, _channelDir: channelDir, _requestFile: file } as SupervisorRequest;
	} catch {
		return undefined;
	}
}

function supervisorAskTimeoutMs(): number {
	const configured = Number(process.env.PI_INTERCOM_ASK_TIMEOUT_MS);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SUPERVISOR_ASK_TIMEOUT_MS;
}

function asyncRequestLifecycle(request: SupervisorRequest): "active" | "inactive" | "unknown" {
	try {
		const status = JSON.parse(fs.readFileSync(path.join(defaultAsyncDir(request.runId), "status.json"), "utf8"));
		if (!isRecord(status) || status.runId !== request.runId) return "unknown";
		const state = typeof status.state === "string" ? status.state : "";
		if (TERMINAL_STATES.has(state) || state === "paused") return "inactive";
		const steps = Array.isArray(status.steps) ? status.steps : [];
		const step = isRecord(steps[request.childIndex]) ? steps[request.childIndex] : undefined;
		const stepState = typeof step?.status === "string" ? step.status : "";
		return TERMINAL_STATES.has(stepState) || stepState === "paused" ? "inactive" : "active";
	} catch {
		return "unknown";
	}
}

function removeRequestFile(file: string): void {
	try { fs.rmSync(file, { force: true }); } catch {}
}

function listPendingSupervisorRequests(ctx: ExtensionContext, ownsTuiRun?: (runId:string)=>boolean): SupervisorRequest[] {
	const root = supervisorRoot();
	const sessionIds = currentSessionIds(ctx);
	const requests: SupervisorRequest[] = [];
	let channels: fs.Dirent[];
	try { channels = fs.readdirSync(root, { withFileTypes: true }); }
	catch { return requests; }
	for (const channel of channels) {
		if (!channel.isDirectory()) continue;
		const channelDir = path.join(root, channel.name);
		const requestsDir = path.join(channelDir, "requests");
		let files: fs.Dirent[];
		try { files = fs.readdirSync(requestsDir, { withFileTypes: true }); }
		catch { continue; }
		for (const entry of files) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const request = parseSupervisorRequest(path.join(requestsDir, entry.name), channelDir);
			if (!request || !request.expectsReply) continue;
			if (!request.orchestratorSessionId || !sessionIds.has(request.orchestratorSessionId)) continue;
			const expiresAt = typeof request.expiresAt === "number" && Number.isFinite(request.expiresAt)
				? request.expiresAt
				: request.createdAt + supervisorAskTimeoutMs();
			const replyFile = path.join(channelDir, "replies", `${request.id.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);
			const lifecycle = asyncRequestLifecycle(request);
			if (fs.existsSync(replyFile) || Date.now() > expiresAt || lifecycle === "inactive") {
				removeRequestFile(request._requestFile);
				continue;
			}
			// Direct replies are intentionally limited to detached async runs created by Pi Bots.
			// Foreground requests stay owned by the native subagent_supervisor so its private
			// FleetView attention state is cleared through the canonical reply path.
			if (lifecycle === "active" || lifecycle==="unknown"&&ownsTuiRun?.(request.runId)) requests.push(request);
		}
	}
	return requests.sort((a, b) => a.createdAt - b.createdAt);
}

function publicSupervisorRequest(request: SupervisorRequest): JsonRecord {
	return {
		id: request.id,
		runId: request.runId,
		agent: request.agent,
		childIndex: request.childIndex,
		reason: request.reason,
		expectsReply: request.expectsReply,
		createdAt: request.createdAt,
		message: request.message,
		...(request.interview !== undefined ? { interview: request.interview } : {}),
	};
}

function writeSupervisorReply(request: SupervisorRequest, message: string): void {
	const repliesDir = path.join(request._channelDir, "replies");
	fs.mkdirSync(repliesDir, { recursive: true, mode: 0o700 });
	const safeId = request.id.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
	const destination = path.join(repliesDir, `${safeId}.json`);
	if (fs.existsSync(destination)) throw new Error(`Supervisor request ${request.id} already has a reply.`);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	const body = JSON.stringify({
		type: "subagent.supervisor.reply",
		requestId: request.id,
		createdAt: Date.now(),
		message: message.trim(),
	}, null, "\t") + "\n";
	fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try { fs.renameSync(temporary, destination); }
	catch (error) {
		try { fs.rmSync(temporary, { force: true }); } catch {}
		throw error;
	}
	try { fs.rmSync(request._requestFile, { force: true }); } catch {}
}

export default function piBotsExtension(pi: ExtensionAPI) {
 pi.registerCommand('pi-bots-settings', {
  description:'Pi Bots: configure native stop when an Orca child tab closes',
  handler:async(args,ctx)=>{
   try {
    const value=args.trim();
    let enabled:boolean|undefined;
    if(value) {
     if(!/^stop-on-tab-close (on|off)$/.test(value)) throw Error('Usage: /pi-bots-settings [stop-on-tab-close on|off]');
     enabled=value.endsWith(' on');
    } else if(ctx.hasUI) {
     const current=stopOnTabClose(settingsFile);
     const selection=await ctx.ui.select(`Pi Bots · Tab schließen beendet Agenten: ${current?'An':'Aus'}`,['An – Kind stoppen; Dispatch-Tab stoppt Workflow (Standard)','Aus – nur Ansicht schließen']);
     if(selection===undefined)return;
     enabled=selection.startsWith('An');
    } else throw Error('Use /pi-bots-settings stop-on-tab-close on|off.');
    saveStopOnTabClose(enabled);
    ctx.ui.notify(`Pi Bots: Tab schließen beendet Agenten ${enabled?'AN':'AUS'}. Gilt auch für laufende neue TUI-Hosts.`, 'info');
   }catch(error){ctx.ui.notify(errorMessage(error),'error');}
  }
 });
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	const trackedRuns = new Map<string, TrackedRun>();
	const retainedRpcListeners = new Set<() => void>();
	const uncertainSpawnRequests = new Set<string>();
	let monitor: ReturnType<typeof setInterval> | undefined;
	let monitorBusy = false;
	let journalFile: string | undefined;
	let sessionKey: string | undefined;
	let launchBusy = false;
	let operations: Record<string, any> = {};
	let latestContext: ExtensionContext | undefined;
	let tuiRequestsBusy = false;
	let tuiRequestsTimer: ReturnType<typeof setInterval> | undefined;
	const persist = () => {
		if (!journalFile) return;
		fs.mkdirSync(path.dirname(journalFile), { recursive: true });
		const temp = `${journalFile}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify({ version: 1, sessionKey, operations, runs: [...trackedRuns.values()].map(run => ({ ...run, published: [...run.published], attempts: [...run.attempts], publishing: [], syncPromise: undefined, syncMissing: false })) }, null, 2));
		fs.renameSync(temp, journalFile);
	};
	const persistOperation = (operation: any) => {
		if (!operation.ownerSession || operation.ownerSession === sessionKey) { persist(); return; }
		const file = operation.ownerJournal;
		if (!file) throw new Error("Original operation journal unavailable");
		const original = JSON.parse(fs.readFileSync(file, "utf8"));
		original.operations[operation.requestId] = operation;
		const temp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(original, null, 2));
		fs.renameSync(temp, file);
	};

	const callRpc = (method: string, params: JsonRecord, signal?: AbortSignal, options: RpcCallOptions = {}): Promise<unknown> => new Promise((resolve, reject) => {
		const requestId = options.requestId ?? `pi-bots-${randomUUID()}`;
		const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
		let callerSettled = false;
		let listenerActive = true;
		let emitted = false;
		let unsubscribe = () => {};
		let timer: ReturnType<typeof setTimeout>;
		const releaseListener = () => {
			if (!listenerActive) return;
			listenerActive = false;
			unsubscribe();
			retainedRpcListeners.delete(releaseListener);
		};
		const detachCaller = (error: Error) => {
			if (callerSettled) return;
			callerSettled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (emitted && options.retainAfterCancellation) {
				retainedRpcListeners.add(releaseListener);
				options.onUncertain?.(requestId);
			} else {
				releaseListener();
			}
			reject(error);
		};
		const onAbort = () => detachCaller(new Error("Pi Bots RPC request aborted."));
		const onReply = (raw: unknown) => {
			const reply = raw as RpcReply;
			if (reply?.version !== RPC_VERSION || reply?.requestId !== requestId) return;
			options.onReceipt?.(reply);
			const wasLate = callerSettled;
			if (!callerSettled) {
				callerSettled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
			releaseListener();
			if (wasLate) {
				try { options.onLateReply?.(reply); } catch {}
				return;
			}
			if (reply?.version !== RPC_VERSION || reply?.requestId !== requestId) {
				reject(new Error("Invalid pi-subagents RPC reply envelope."));
			} else if (reply.success === true) {
				resolve(reply.data);
			} else {
				reject(new Error(`${reply?.error?.code ? `${reply.error.code}: ` : ""}${reply?.error?.message || "Unknown pi-subagents RPC error."}`));
			}
		};
		unsubscribe = pi.events.on(replyEvent, onReply);
		timer = setTimeout(() => detachCaller(new Error(`pi-subagents RPC timed out after ${MAX_RPC_WAIT_MS} ms.`)), MAX_RPC_WAIT_MS);
		timer.unref?.();
		if (signal?.aborted) onAbort();
		else {
			signal?.addEventListener("abort", onAbort, { once: true });
			emitted = true;
			pi.events.emit(RPC_REQUEST_EVENT, { version: RPC_VERSION, requestId, method, params });
		}
	});

	const attachTrackedRun = (data: unknown, viewMode: ViewMode, titlePrefix: string): TrackedRun | undefined => {
		const location = extractRunLocation(data);
		if (!location.runId || !location.asyncDir) return undefined;
		const existing = trackedRuns.get(location.runId);
		if (existing) return existing;
		const run: TrackedRun = {
			runId: location.runId,
			asyncDir: location.asyncDir,
			viewMode,
			titlePrefix: cleanTitle(titlePrefix || "Pi Bot"),
			active: true,
			published: new Set(),
			publishing: new Set(),
			attempts: new Map(),
		};
		trackedRuns.set(run.runId, run);
		persist();
		return run;
	};

	const resultOutcome = (value: JsonRecord): string => {
		const report = isRecord(value.json) ? value.json : undefined;
		return typeof report?.summary === "string"
			? report.summary
			: typeof value.error === "string"
				? value.error
			: typeof value.stderr === "string"
				? value.stderr
				: `exit ${String(value.exitCode)}`;
	};

const compactCause = (value: unknown): string => {
		const first = String(value ?? "unknown error").split("\n")[0];
		return first ? first.slice(0, 240) : "unknown error";
	};

const announceViewWave = (views: JsonRecord, prefix = "Pi Bots views") => {
		const results = Array.isArray(views.results) ? views.results : [];
		if (results.length === 0) return;
		const lines = [`${prefix} for run ${String(views.runId ?? "unknown")} (native state: ${String(views.state ?? "unknown")}):`];
		for (const value of results) {
			if (!isRecord(value)) continue;
			lines.push(`- Child ${String(value.index)}: ${resultOutcome(value)}`);
		}
		const content = lines.join("\n");
		// Dedupe per run: only a change of child identity, run state, tab
		// connection, or error state is published. Timestamps and heartbeats
		// never create a new chat message; the live UI keeps updating. The
		// signature persists in the run journal, so a reload does not
		// republish unchanged states.
		const signature = JSON.stringify([
			String(views.state ?? "unknown"),
			views.waitingForStatus === true ? "waiting" : "",
			results.filter(isRecord).map((value) => [value.index, resultOutcome(value)]),
		]);
		const run = trackedRuns.get(String(views.runId ?? ""));
		if (run && run.lastWaveSignature === signature) return;
		if (run) run.lastWaveSignature = signature;
		pi.sendMessage({ customType: "pi_bots_view_wave", content, display: true, details: views }, { triggerTurn: false });
	};

const announceChildFailures = (run: TrackedRun, views: JsonRecord) => {
		const results = Array.isArray(views.results) ? views.results : [];
		const failures: { index: unknown; error: string }[] = [];
		for (const value of results) {
			if (!isRecord(value)) continue;
			const host =
				isRecord(value.json) && isRecord(value.json.host) ? (value.json.host as JsonRecord) : undefined;
			const failed =
				(typeof value.error === "string" && value.error.length > 0) ||
				host?.state === "failed";
			if (!failed) continue;
			failures.push({
				index: value.index,
				error: compactCause(value.error || host?.error || `child ${String(value.index)} stopped (host state: ${String(host?.state ?? "unknown")})`),
			});
		}
		if (failures.length === 0) return;
		const signature = JSON.stringify(failures);
		if (run.lastFailureSignature === signature) return;
		run.lastFailureSignature = signature;
		persist();
		const healthy = results.filter(
			(value) => isRecord(value) && !(typeof value.error === "string" && value.error.length > 0),
		).length;
		const lines = [`Pi Bots run ${run.runId}: failed child(ren) while the workflow is still running:`];
		for (const failure of failures) lines.push(`- Child ${String(failure.index)}: ${failure.error}`);
		lines.push(
			`Run state: ${String(views.state ?? "unknown")}; results so far: ${healthy}/${results.length} children without error. Full stack traces stay in the run artifacts.`,
		);
		pi.sendMessage({
			customType: "pi_bots_child_failed",
			content: lines.join("\n"),
			display: true,
			details: { runId: run.runId, failures },
		}, { triggerTurn: false });
	};

	const monitorRuns = async () => {
		if (monitorBusy) return;
		monitorBusy = true;
		try {
			for (const run of trackedRuns.values()) {
				if (run.coordinationRoot) {
					const health=bridgeStatus(run.coordinationRoot)?.health;
					const error=health?.connected === false ? health.error : undefined;
					if (error !== run.lastCoordinationError) {
						pi.sendMessage({customType:"pi_bots_connection",content:error ? `Orca connection interrupted for native run ${run.runId}: ${error} Native execution continues.` : `Orca connection restored for native run ${run.runId}.`,display:true},{triggerTurn:false});
						run.lastCoordinationError=error;
					}
				}
				if (run.active || run.coordinationRoot && !bridgeStatus(run.coordinationRoot)?.health?.done) {
					const views = await syncTrackedRun(run);
					announceChildFailures(run, views);
					announceViewWave(views);
				}
			}
			persist();
			if (![...trackedRuns.values()].some((run) => run.active || run.coordinationRoot && !bridgeStatus(run.coordinationRoot)?.health?.done) && monitor) {
				clearInterval(monitor);
				monitor = undefined;
			}
		} finally {
			monitorBusy = false;
		}
	};

	const ensureMonitor = () => {
		if (monitor || ![...trackedRuns.values()].some((run) => run.active || run.coordinationRoot && !bridgeStatus(run.coordinationRoot)?.health?.done)) return;
		monitor = setInterval(() => { void monitorRuns(); }, VIEW_MONITOR_MS);
		monitor.unref?.();
	};

	const resolveRun = async (runId: string, asyncDir: string | undefined, signal?: AbortSignal): Promise<{ runId: string; asyncDir: string }> => {
		if (!validRunId(runId)) throw new Error("runId must contain only letters, numbers, dot, underscore, and hyphen (max 128 characters).");
		const tracked = trackedRuns.get(runId);
		if (asyncDir) return { runId, asyncDir: path.resolve(asyncDir) };
		if (tracked) return { runId, asyncDir: tracked.asyncDir };
		try {
			const data = await callRpc("status", { id: runId }, signal);
			const found = extractRunLocation(data);
			if (found.asyncDir) return { runId: found.runId ?? runId, asyncDir: found.asyncDir };
		} catch {}
		const fallback = defaultAsyncDir(runId);
		if (fs.existsSync(path.join(fallback, "status.json"))) return { runId, asyncDir: fallback };
		throw new Error(`Could not resolve async directory for run ${runId}. Pass asyncDir explicitly.`);
	};

 const acceptReceipt = (operation: any, reply: RpcReply) => {
  if (reply.version !== RPC_VERSION || reply.requestId !== operation.requestId) return;
  operation.reply = reply;
  operation.state = reply.success ? "received" : "failed";
  if (operation.ownerSession && operation.ownerSession !== sessionKey) {
   // A receipt belongs to the session that issued the request. Returning to
   // that session will attach its exact run; never import it into another one.
   persistOperation(operation);
   const location=extractRunLocation(reply.data);
   if (reply.success && location.runId && location.asyncDir && operation.coordinationRoot) attachNative(operation.coordinationRoot,location,supervisorRoot());
   else if (!reply.success && operation.coordinationRoot && !operation.reusesDispatch) void failBeforeNative(operation.coordinationRoot,reply.error?.message || "Native RPC failed");
   return;
  }
  uncertainSpawnRequests.delete(operation.requestId);
  if (reply.success) {
   const run = attachTrackedRun(reply.data, operation.viewMode, operation.titlePrefix);
   if (run) {
    operation.runId = run.runId;
    run.execution = operation.execution || "headless";
    if (operation.coordinationRoot) {
     run.coordinationRoot = operation.coordinationRoot;
     attachNative(run.coordinationRoot, {runId: run.runId, asyncDir: run.asyncDir}, supervisorRoot());
    }
   } else {
    operation.state = "unknown";
    uncertainSpawnRequests.add(operation.requestId);
   }
  } else if (operation.coordinationRoot && !operation.reusesDispatch) {
   void failBeforeNative(operation.coordinationRoot, reply.error?.message || "Native RPC failed");
  }
  persist(); ensureMonitor();
 };

 const loadState = (ctx: ExtensionContext) => {
  latestContext = ctx;
  const key = [...currentSessionIds(ctx)][0];
  if (!key || key === sessionKey) return;
  persist();
  if (monitor) clearInterval(monitor);
  monitor = undefined;
  for (const unsubscribe of [...retainedRpcListeners]) unsubscribe();
  retainedRpcListeners.clear();trackedRuns.clear();uncertainSpawnRequests.clear();
  sessionKey = key;
  const digest = createHash("sha256").update(key).digest("hex");
  journalFile = path.join(piSubagentsTempRoot(), "pi-bots-state", digest, "journal.json");
  let saved: any;
  try { saved = JSON.parse(fs.readFileSync(journalFile, "utf8")); } catch {}
  operations = saved?.version === 1 && saved.sessionKey === key ? saved.operations ?? {} : {};
  for (const run of saved?.runs ?? []) {
   if (!validRunId(run.runId) || !path.isAbsolute(run.asyncDir)) continue;
   trackedRuns.set(run.runId, {...run, published: new Set(run.published), publishing: new Set(), attempts: new Map(run.attempts), syncPromise: undefined, syncMissing: false});
  }
  for (const operation of Object.values(operations)) {
   if (operation.reply) acceptReceipt(operation, operation.reply);
   else if (!operation.nativeSent && operation.coordinationRoot && fs.existsSync(path.join(operation.coordinationRoot, "mapping.json"))) {
    // A dispatch may have completed while the parent stopped before its RPC.
    // Settle that original dispatch as a failed launch, never start a replacement.
    operation.state = "not_sent";
    if(!operation.reusesDispatch)void failBeforeNative(operation.coordinationRoot, "Parent stopped before native RPC was sent");
    persist();
   }
   else if (["pending", "unknown", "preparing"].includes(operation.state)) {
    uncertainSpawnRequests.add(operation.requestId);
    // Re-subscribe to the original ID after an extension reload. Never re-emit
    // spawn/resume: native RPC has no durable query/replay endpoint in 0.65.1.
    const unsubscribe = pi.events.on(RPC_REPLY_PREFIX + operation.requestId, (reply: unknown) => {
     acceptReceipt(operation, reply as RpcReply);
     if (operation.reply) {unsubscribe();retainedRpcListeners.delete(unsubscribe);}
    });
    retainedRpcListeners.add(unsubscribe);
    // Query the original durable request without re-emitting its mutation.
    void callRpc("receipt",{requestId:operation.requestId}).then((receipt:any)=>{
     if(receipt?.reply)acceptReceipt(operation,receipt.reply);
    }).catch(()=>{});
   }
  }
  ensureMonitor();
 };

 const nativeLaunch = async (method: "spawn" | "resume", nativeParams: JsonRecord, options: any, ctx: ExtensionContext, signal?: AbortSignal) => {
  if (launchBusy || uncertainSpawnRequests.size) throw new Error("Retry is blocked: a previous Pi Bots start/resume has an unresolved outcome. Inspect the original request in " + journalFile);
  if (signal?.aborted) throw new Error("Pi Bots RPC request aborted before launch.");
  launchBusy = true;
  const previous = method === "resume" ? trackedRuns.get(String(nativeParams.id)) : undefined;
  const operation: any = {
   requestId: options.requestId || "pi-bots-" + randomUUID(), method, params: nativeParams,
   viewMode: options.viewMode ?? previous?.viewMode ?? "both",
   titlePrefix: cleanTitle(options.titlePrefix ?? previous?.titlePrefix ?? "Pi Bot"),
   coordination: options.coordination ?? (previous?.coordinationRoot ? "orca" : "native"),
   execution: options.execution ?? previous?.execution ?? "headless",
   state: "preparing", createdAt: Date.now(),
   ownerSession: sessionKey, ownerJournal: journalFile,
  };
  operations[operation.requestId] = operation;
  try {
   const previousViewPolicy = previous?.coordinationRoot ? bridgeStatus(previous.coordinationRoot)?.tuiViewPolicy : undefined;
   operation.dispatchView = options.dispatchView ?? (previous?.coordinationRoot ? (previousViewPolicy === "dispatch-first" ? "shared" : "separate") : "shared");
   if (!["shared", "separate"].includes(operation.dispatchView)) throw new Error("dispatchView must be shared or separate.");
   if (options.dispatchView !== undefined && operation.execution !== "orca-tui") throw new Error("dispatchView requires execution:orca-tui.");
   if (operation.execution === "orca-tui") {
    resolveTuiResources();
    if (operation.coordination !== "orca") throw new Error("orca-tui requires coordination:orca.");
    if (!["both", "orca"].includes(operation.viewMode)) throw new Error("orca-tui requires Orca views (viewMode:orca or both).");
    const capability: any = await callRpc("ping", {}, signal);
    if (capability?.capabilities?.childExecution?.version !== 1) throw new Error("The loaded backend does not support Orca TUI children. Enable pi-orca-subagents as a complete package and reload Pi.");
   }
   if (operation.coordination === "orca") {
    // A paused workflow keeps its dispatch. Resuming a settled workflow is a
    // new native workflow attempt and receives exactly one new dispatch.
    if (previous?.coordinationRoot && readStatus(previous)?.state === "paused" && !bridgeStatus(previous.coordinationRoot)?.health?.done) {
     if (operation.dispatchView !== (previousViewPolicy === "dispatch-first" ? "shared" : "separate")) throw new Error("An active workflow retains its original dispatch view layout during resume.");
     operation.coordinationRoot = previous.coordinationRoot;
     operation.reusesDispatch = true;
    } else {
     operation.coordinationRoot = path.join(path.dirname(journalFile!), "workflows", operation.requestId);
     persistOperation(operation);
     await prepareWorkflow(operation.coordinationRoot, String(nativeParams.cwd || ctx.cwd), nativeParams,
      {piBotsSettingsFile:settingsFile,...(operation.execution === "orca-tui" && operation.dispatchView === "shared"
       ? {tuiViewPolicy:"dispatch-first"} : {})});
    }
   }
   if (signal?.aborted || operation.ownerSession !== sessionKey) {
    operation.state = "not_sent";persistOperation(operation);
    if (operation.coordinationRoot && !operation.reusesDispatch) await failBeforeNative(operation.coordinationRoot, "Caller cancelled before native launch");
    throw new Error("Pi Bots RPC request aborted before launch.");
   }
   if (operation.execution === "orca-tui") {
    nativeParams.childExecution = {version:1,type:"orca-tui",coordinationRoot:operation.coordinationRoot,parentJournal:journalFile,
     ...resolveTuiResources()};
   }
   operation.state = "pending";
   operation.nativeSent = true;
   uncertainSpawnRequests.add(operation.requestId);persistOperation(operation);
   const data = await callRpc(method, nativeParams, signal, {
    requestId: operation.requestId, retainAfterCancellation: true,
    onReceipt: reply => acceptReceipt(operation, reply),
    onUncertain: () => {operation.state = "unknown";persistOperation(operation);},
    onLateReply: reply => {
     if(operation.ownerSession !== sessionKey)return;
     pi.sendMessage({customType: "pi_bots_late_spawn",content: "Late " + method + " receipt for original request " + operation.requestId + ": " + (operation.runId || reply.error?.message || "identity unresolved"),display:true}, {triggerTurn:false});
    },
   });
   const run = operation.runId ? trackedRuns.get(operation.runId) : undefined;
   if (!run) throw new Error("Native launch succeeded without a resolvable identity. Replacement remains blocked.");
   const views = await syncTrackedRun(run, signal);persist();ensureMonitor();
   return textResult(rpcText(data) + "\n\n" + formatViewSync(views), {rpc:data as JsonRecord,runId:run.runId,asyncDir:run.asyncDir,views,requestId:operation.requestId,...(run.coordinationRoot?{coordination:bridgeStatus(run.coordinationRoot)}:{})});
  } catch (error) {
   if (operation.state === "preparing") {
    const root = operation.coordinationRoot;
    const mutated = root && ["coordinator", "workflow"].some(role => fs.existsSync(path.join(root, role, "terminal.claim")) || fs.existsSync(path.join(root, role, "daemon.claim")));
    operation.state = mutated ? "unknown" : "not_sent";
    if (mutated) uncertainSpawnRequests.add(operation.requestId);
    persistOperation(operation);
   }
   throw error;
  } finally {launchBusy = false;}
 };

 const offManagedResume = pi.events.on("pi-bots:managed-resume:v1", (request: any) => {
  loadState(request.ctx);
  const owned=trackedRuns.get(request.params.id);
  if(owned?.execution!=="orca-tui" || request.result)return;
  const {action,childExecution,...params}=request.params;
  request.result=nativeLaunch("resume",params,{execution:"orca-tui",coordination:"orca",viewMode:owned.viewMode},request.ctx,request.signal).then(result=>({
   content:result.content,details:(result.details.rpc as any)?.details||{mode:"management",results:[]},...(result.isError?{isError:true}:{})
  }));
 });
 const findOwnedTuiRun=(id:string)=>trackedRuns.get(id)??[...trackedRuns.values()].find(run=>run.execution==="orca-tui"&&nativeTuiChildren(run).some(child=>child.runId===id));
 const pendingSupervisor=(ctx:ExtensionContext)=>listPendingSupervisorRequests(ctx,id=>Boolean(findOwnedTuiRun(id)));
 const processTuiRequests = async () => {
  if(tuiRequestsBusy || !journalFile || !latestContext)return;
  const dir=path.join(path.dirname(journalFile),"tui-requests");
  if(!fs.existsSync(dir))return;
  tuiRequestsBusy=true;
  try {
   for(const name of fs.readdirSync(dir).filter(name=>/^tui-[a-f0-9-]+\.json$/.test(name))) {
    const file=path.join(dir,name),response=file+".reply.json";
    if(fs.existsSync(response))continue;
    const request=JSON.parse(fs.readFileSync(file,"utf8"));
    const original=findOwnedTuiRun(request.runId);
    if(!original || original.execution!=="orca-tui")continue;
    const relative=path.relative(path.join(original.asyncDir,"tui"),request.manifest||"");
    if((!relative || relative.startsWith("..") || path.isAbsolute(relative))&&!nativeTuiChildren(original).some(child=>child.manifest===request.manifest&&child.runId===request.runId))continue;
    const host=JSON.parse(fs.readFileSync(request.manifest,"utf8"));
    if(host.runId!==request.runId || host.index!==request.index || host.sessionFile!==request.sessionFile)continue;
    const nativeRequestId="pi-bots-"+request.id;
    const previous=operations[nativeRequestId];
    if(previous){if(previous.reply)fs.writeFileSync(response,JSON.stringify(previous.reply));continue;}
    if(launchBusy || uncertainSpawnRequests.size)continue;
    try {
     if(request.kind==="resume") {
      const index=original.runId===request.runId?request.index:(readStatus(original)?.steps as any[])?.findIndex(step=>step.runId===request.runId||step.sessionFile===request.sessionFile);
      if(index===undefined||index<0)throw new Error("Native workflow child index is unconfirmed.");
      const result=await nativeLaunch("resume",{id:original.runId,index,message:request.message},{execution:"orca-tui",coordination:"orca",viewMode:original.viewMode,requestId:nativeRequestId},latestContext);
      fs.writeFileSync(response,JSON.stringify({success:!result.isError,data:result}));
     } else if(request.kind==="supervisor_reply") {
      const pending=pendingSupervisor(latestContext).find(r=>r.id===request.replyTo && r.runId===request.runId && r.childIndex===request.index);
      if(!pending)throw new Error("The supervisor request has already been answered or is no longer pending.");
      if(original.coordinationRoot)captureNativeQuestion(original.coordinationRoot,pending);
      const result=await callRpc("supervisor",{action:"reply",replyTo:request.replyTo,message:request.message},undefined,{requestId:nativeRequestId});
      if(original.coordinationRoot)confirmNativeReply(original.coordinationRoot,request.replyTo,request.message);
      fs.writeFileSync(response,JSON.stringify({success:true,data:result}));
     }
    }catch(error){
     if(!operations[nativeRequestId] || operations[nativeRequestId].reply)fs.writeFileSync(response,JSON.stringify({success:false,error:String(error)}));
    }
   }
  }finally{tuiRequestsBusy=false;}
 };
 tuiRequestsTimer=setInterval(()=>{void processTuiRequests().catch(error=>{if(latestContext?.hasUI)latestContext.ui.notify(String(error),"error");});},1000);
 tuiRequestsTimer.unref?.();

 pi.on("session_start", (_event, ctx) => loadState(ctx));
 pi.on("tool_call", (event: any, ctx: ExtensionContext) => {
  loadState(ctx);
  if (event.toolName !== "subagent_supervisor") return;
  // Snapshot before the canonical tool consumes its request file. Do not run
  // wrapper housekeeping here: only the native supervisor decides liveness.
  const root=supervisorRoot();
  for(const name of fs.existsSync(root)?fs.readdirSync(root):[]) {
   const channel=path.join(root,name),requests=path.join(channel,"requests");
   if(!fs.existsSync(requests))continue;
   for(const file of fs.readdirSync(requests).filter(name=>name.endsWith(".json"))) {
    const request=parseSupervisorRequest(path.join(requests,file),channel);
    if(!request)continue;
    const run=findOwnedTuiRun(request.runId);
    if(run?.coordinationRoot && request.expectsReply)captureNativeQuestion(run.coordinationRoot,request);
   }
  }
 });
 pi.on("tool_result", (event: any, ctx: ExtensionContext) => {
  loadState(ctx);
  if (event.toolName !== "subagent_supervisor" || event.isError || event.input?.action !== "reply") return;
  const id=event.details?.replyTo, runId=event.details?.runId;
  if (typeof id !== "string" || typeof event.input?.message !== "string") return;
  const run=trackedRuns.get(runId);
  if (run?.coordinationRoot) confirmNativeReply(run.coordinationRoot,id,event.input.message);
 });

	pi.registerTool({
		name: "pi_bots",
		label: "Pi Bots",
		description: "Transparent pass-through to the native pi-subagents engine: workflows, supervisor replies, and owned views. It adds no control plane of its own - native Pi processes remain the lifecycle authority and the native run's status.json the execution state; Orca/Herdr are spectators. execution:orca-tui runs each native child in its real interactive Pi TUI in Orca; headless remains the compatible default.",
		promptSnippet: "For requested visible Pi agents use execution:orca-tui, coordination:orca and viewMode:orca (or both for Herdr too). The same native child supports chat, interruption, todo and supervisor replies in its Pi TUI.",
		promptGuidelines: [
			"Use action=start with launch containing native pi-subagents agent/task or workflowScript parameters; async is forced true.",
			"Use supervisor_pending before supervisor_reply; child agents initiate supervisor requests.",
			"execution defaults headless and coordination defaults native. orca-tui requires Orca dispatch coordination. All supervisor answers use the canonical native handler; native Pi owns stop and resume.",
			"Orca Pi TUIs accept input; Herdr and headless file views are read-only. Closing views detaches without stopping children. A user request to close owned views authorizes cleanup_preflight and cleanup_views with confirm:true.",
			"For features not represented here, use the native subagent tool instead of guessing.",
		],
		parameters: PiBotsParams,
		executionMode: "sequential",
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = rawParams as {
				action: string;
				launch?: JsonRecord;
				runId?: string;
				asyncDir?: string;
				childId?: string;
				index?: number;
				message?: string;
				mode?: "steer" | "follow_up" | "auto";
				replyTo?: string;
				viewMode?: ViewMode;
				coordination?: "native" | "orca";
				execution?: "headless" | "orca-tui";
				dispatchView?: "shared" | "separate";
				titlePrefix?: string;
				output?: string;
				confirm?: boolean;
			};
			try {
    loadState(ctx);
    if (params.action === "start") {
     if (!isRecord(params.launch) || !Object.keys(params.launch).length) throw new Error("start requires launch parameters.");
     if (params.launch.action || params.launch.async === false) throw new Error("launch must be a native async launch, without action or async:false.");
     return await nativeLaunch("spawn", {...params.launch,async:true,cwd:params.launch.cwd || ctx.cwd}, params,ctx,signal);
    }

				if (params.action === "status") {
					const target: JsonRecord = {};
					if (params.runId) target.id = params.runId;
					if (params.asyncDir) target.dir = params.asyncDir;
					if (params.index !== undefined) target.index = params.index;
					const data = await callRpc("status", target, signal);
					let views: JsonRecord | undefined;
					if (params.runId && trackedRuns.has(params.runId)) views = await syncTrackedRun(trackedRuns.get(params.runId)!, signal);
					return textResult(`${rpcText(data)}${views ? `\n\n${formatViewSync(views)}` : ""}`, { rpc: data as JsonRecord, ...(views ? { views } : {}) });
				}

				if (params.action === "steer") {
					if (!params.runId || !params.message?.trim()) throw new Error("steer requires runId and a non-empty message.");
					const data = await callRpc("steer", { id: params.runId, message: params.message.trim(), ...(params.index !== undefined ? {index:params.index} : {}), ...(params.mode ? { mode: params.mode } : {}) }, signal);
					return textResult(rpcText(data), { rpc: data as JsonRecord });
				}

				if (params.action === "interrupt") {
					if (!params.runId) throw new Error("interrupt requires runId.");
					const data = await callRpc("interrupt", { id: params.runId, ...(params.index !== undefined ? { index: params.index } : {}) }, signal);
					return textResult(rpcText(data), { rpc: data as JsonRecord });
				}

				if (params.action === "stop") {
					if (!params.runId) throw new Error("stop requires runId.");
					const data = await callRpc("stop", { id: params.runId, ...(params.childId ? { childId: params.childId } : {}) }, signal);
					return textResult(rpcText(data), { rpc: data as JsonRecord });
				}

    if (params.action === "resume") {
     if (!params.runId || !params.message?.trim()) throw new Error("resume requires runId and a non-empty message.");
     return await nativeLaunch("resume", {id:params.runId,message:params.message.trim(),...(params.index!==undefined?{index:params.index}:{}),...(params.output?{output:params.output,outputMode:"file-only"}:{})},params,ctx,signal);
    }

				if (params.action === "supervisor_pending") {
					const pending = pendingSupervisor(ctx).map(publicSupervisorRequest);
					const text = pending.length
						? pending.map((item) => `- ${item.id}: ${item.agent} [${item.runId}#${item.childIndex}] ${item.reason}\n  ${String(item.message).replace(/\n/g, "\n  ")}`).join("\n")
						: "No pending supervisor requests.";
					return textResult(text, { pending });
				}

				if (params.action === "supervisor_reply") {
					if (!params.replyTo || !params.message?.trim()) throw new Error("supervisor_reply requires replyTo and a non-empty message.");
					const request = pendingSupervisor(ctx).find((candidate) => candidate.id === params.replyTo);
					if (!request) throw new Error(`No pending supervisor request found for replyTo '${params.replyTo}'.`);
					const owner = findOwnedTuiRun(request.runId);
					if(owner?.execution === "orca-tui") {
						if(owner.coordinationRoot)captureNativeQuestion(owner.coordinationRoot,request);
						const result=await callRpc("supervisor",{action:"reply",replyTo:request.id,message:params.message},signal);
						if(owner.coordinationRoot)confirmNativeReply(owner.coordinationRoot,request.id,params.message);
						return textResult(rpcText(result),{rpc:result as JsonRecord});
					}
					if (owner?.coordinationRoot) throw new Error("Use native subagent_supervisor({action:\"reply\",replyTo:" + JSON.stringify(request.id) + ",message:...}); Pi Bots mirrors only its confirmed reply.");
					writeSupervisorReply(request, params.message);
					return textResult(`Replied to supervisor request ${request.id}.`, { replyTo: request.id, runId: request.runId, agent: request.agent });
				}

				if (params.action === "sync_views") {
					if (!params.runId) throw new Error("sync_views requires runId.");
					const location = await resolveRun(params.runId, params.asyncDir, signal);
					const existing = trackedRuns.get(location.runId);
					const run: TrackedRun = existing ?? {
						runId: location.runId,
						asyncDir: location.asyncDir,
						viewMode: params.viewMode ?? "both",
						titlePrefix: cleanTitle(params.titlePrefix || "Pi Bot"),
						active: true,
						published: new Set(),
						publishing: new Set(),
						attempts: new Map(),
					};
					if (params.viewMode) run.viewMode = params.viewMode;
                    if (run.syncPromise) await run.syncPromise;
                    run.published.clear(); run.attempts.clear(); run.syncMissing = true;
					trackedRuns.set(run.runId, run);
					const views = await syncTrackedRun(run, signal);
                    run.syncMissing = false; persist();
					ensureMonitor();
					return textResult(formatViewSync(views), { views });
				}

				if (params.action === "cleanup_preflight" || params.action === "cleanup_views") {
					if (!params.runId) throw new Error(`${params.action} requires runId.`);
					const managed=trackedRuns.get(params.runId);
					if(managed?.execution==="orca-tui"){
						const report=await cleanupTuiViews(managed);
						const herdr=managed.viewMode==="both"?await runPowerShell(CLOSE_SCRIPT,["-RunId",params.runId,"-PreflightOnly"],signal):undefined;
						if(params.action==="cleanup_preflight")return textResult(JSON.stringify(report),{preflight:report,...(herdr?{herdr:herdr.json}:{})});
						if(!report.cleanupNeeded&&!herdr?.json?.cleanupNeeded)return textResult("No owned Pi Bot views remain open.",{preflight:report});
						if(herdr?.json?.cleanupNeeded&&herdr.json.safeToClose!==true)throw new Error("Herdr view cleanup cannot be verified; views remain open.");
						const confirmed=params.confirm===true || ctx.hasUI&&await ctx.ui.confirm("Close Pi Bot views?",report.stopOnTabClose ? "Close this run's views and stop their native children? The shared dispatch tab stops the workflow." : "Close this run's views? Native children continue; closing the shared tab cancels its Orca dispatch.");
						if(!confirmed)return textResult("View cleanup cancelled.",{cancelled:true});
						const closed=await cleanupTuiViews(managed,true);
						if(herdr?.json?.cleanupNeeded)await runPowerShell(CLOSE_SCRIPT,["-RunId",params.runId],signal);
						return textResult(closed.stopOnTabClose ? "Owned Pi Bot views closed; native tab-close stop is pending confirmation." : "Owned Pi Bot views detached; native stop on close is disabled.",{cleanup:closed});
					}
					const preflight = await runPowerShell(CLOSE_SCRIPT, ["-RunId", params.runId, "-PreflightOnly"], signal);
					const report = preflight.json;
					if (!report) throw new Error(preflight.error || preflight.stderr.trim() || preflight.stdout.trim() || "Cleanup preflight returned no JSON report.");
					if (params.action === "cleanup_preflight") {
						return textResult(preflight.stdout.trim() || JSON.stringify(report, null, 2), { preflight: report }, preflight.exitCode !== 0);
					}
					if (report.cleanupNeeded !== true) return textResult(`No external Pi Bot views need cleanup for run ${params.runId}.`, { preflight: report });
					if (report.safeToClose !== true) return textResult(`Cleanup is not safe for run ${params.runId}; no views were closed.`, { preflight: report }, true);
					let confirmed = params.confirm === true;
					if (ctx.hasUI && !confirmed) {
						confirmed = await ctx.ui.confirm(
							"Close Pi Bot spectator tabs?",
							`Close only the verified Herdr/Orca spectator views owned by run ${params.runId}? This does not stop child agents.`,
						);
					}
					if (!confirmed) return textResult("Pi Bot view cleanup cancelled; no views were closed.", { preflight: report, cancelled: true });
					const closed = await runPowerShell(CLOSE_SCRIPT, ["-RunId", params.runId], signal);
					const closeReport = closed.json;
					if (!closeReport) throw new Error(closed.error || closed.stderr.trim() || closed.stdout.trim() || "Cleanup returned no JSON report.");
					return textResult(closed.stdout.trim() || JSON.stringify(closeReport, null, 2), { preflight: report, cleanup: closeReport }, closed.exitCode !== 0);
				}

				throw new Error(`Unsupported Pi Bots action: ${params.action}`);
			} catch (error) {
				return textResult(`Error: ${errorMessage(error)}`, { error: errorMessage(error), action: params.action }, true);
			}
		},
	});

	pi.on("session_shutdown", () => {
        if(typeof offManagedResume==="function")offManagedResume();
        if(tuiRequestsTimer)clearInterval(tuiRequestsTimer);
        persist();
		if (monitor) clearInterval(monitor);
		monitor = undefined;
		for (const unsubscribe of [...retainedRpcListeners]) unsubscribe();
		retainedRpcListeners.clear();
		uncertainSpawnRequests.clear();
		trackedRuns.clear();
	});
}
