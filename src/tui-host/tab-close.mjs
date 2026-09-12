import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJson, atomicJson} from './protocol.mjs';

export function stopOnTabClose(settingsFile) {
  // Missing setting means the documented default. Invalid files fail visibly;
  // they must never silently override an explicit false with true.
  if (!settingsFile || !fs.existsSync(settingsFile)) return true;
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const value = settings.piBots?.stopOnTabClose;
  if (value !== undefined && typeof value !== 'boolean') throw Error('piBots.stopOnTabClose must be a boolean.');
  return value !== false;
}

// The shared dispatch tab is the workflow's own terminal; separately created
// child tabs are not.
export function isDispatchView(host, mapping) {
  return !!(
    host?.dispatchView &&
    host?.view &&
    mapping?.worker?.terminal?.paneKey &&
    host.view.paneKey === mapping.worker.terminal.paneKey
  );
}

// Existence checks must query the tab's own workspace: the shared dispatch
// tab lives in the workflow area, separately created child tabs in the
// child's launch directory. An inventory from the other workspace can never
// prove that the tab was closed (create-beta regression).
// The dispatch tab is created with --worktree <workflow cwd>, so
// mapping.cwd is its Orca workspace. mapping.worker.dir is only the
// adapter's state directory (never an Orca-known workspace) and must not
// be used for existence probes (live-acceptance regression: the probe
// returned selector_not_found for the whole 60 s cap).
export function workspaceForView(host, mapping, launchCwd) {
  return isDispatchView(host, mapping)
    ? mapping.cwd || launchCwd
    : launchCwd;
}

// Two consecutive confirmed absences on the same reachable Orca runtime
// prove a close. 'present' and 'unknown' (connection error, runtime switch,
// unreadable inventory) both break the streak of confirmed absences.
export function createAbsenceTracker(originalRuntime) {
  let missingCount = 0;
  let observedRuntime = originalRuntime;
  return {
    // The runtime the tab was last positively observed in (or was expected in).
    runtime() { return observedRuntime; },
    // Feed one probe; 'present' must carry the current runtimeId.
    probe(presence, runtimeId) {
      if (presence === 'present') {
        missingCount = 0;
        if (runtimeId) observedRuntime = runtimeId;
        return 'present';
      }
      if (presence === 'missing') {
        missingCount += 1;
        return missingCount >= 2 ? 'absent' : 'pending';
      }
      missingCount = 0;
      return 'unknown';
    },
    // Positive evidence outside a probe (e.g. a view attached right now).
    markObserved(runtimeId) {
      if (runtimeId) {
        observedRuntime = runtimeId;
        missingCount = 0;
      }
    },
  };
}

export function tabPresence(runtime, listed, view, originalRuntime) {
  if (runtime?.reachable !== true || !Array.isArray(listed?.terminals)) return 'unknown';
  const found = listed.terminals.some(t => t.tabId === view.tabId &&
    (t.paneKey || (t.tabId && t.leafId ? `${t.tabId}:${t.leafId}` : undefined)) === view.paneKey);
  if (found) return 'present';
  // A new runtime may still be restoring its tabs. Absence in that inventory
  // alone does not prove an operator close.
  if (!originalRuntime || runtime.runtimeId !== originalRuntime) return 'unknown';
  return 'missing';
}

export function requestTabStop(host) {
  const mapping = readJson(path.join(host.coordinationRoot, 'mapping.json'));
  const ownDir = path.resolve(host.root, '../..');
  const targets = host.dispatchView && host.view.paneKey === mapping.worker.terminal.paneKey
    ? mapping.nativeRuns : [{runId:host.runId, asyncDir:ownDir, index:host.index}];
  if (!targets?.length) throw Error('Native workflow identity is not yet confirmed; tab-close stop remains pending.');
  const requests = [];
  for (const target of targets) {
    const status = readJson(path.join(target.asyncDir, 'status.json'));
    if (status?.runId !== target.runId) throw Error('Native tab-close target identity mismatch.');
    if (status.state !== 'running' && status.state !== 'queued') continue;
    const requestId = `${host.tabClose.requestId}-${target.runId}`;
    if (status.mode === 'workflow') {
      const owner = path.join(host.coordinationRoot, 'native-workflow-host');
      const descriptor = readJson(path.join(owner, 'launch.json'));
      if (!readJson(path.join(owner, 'host.json')) || descriptor?.sessionId !== status.sessionId)
        throw Error('Original native workflow controller is unavailable; no replacement started.');
      const request = {version:1, requestId, method:'stop', params:{id:target.runId}};
      const file = path.join(owner, 'commands', createHash('sha256').update(requestId).digest('hex') + '.json');
      if (!fs.existsSync(file)) atomicJson(file, request);
      requests.push({runId:target.runId,file});
    } else {
      // The native runner consumes this same cross-platform stop inbox for RPC.
      // Persist delivery before retries: never recreate a consumed request.
      const receipt = path.join(host.root, requestId + '.stop.json');
      const file = path.join(target.asyncDir, 'control', 'stop-requests', requestId + '.json');
      if (!fs.existsSync(receipt)) {
        const request = {type:'stop',ts:host.tabClose.confirmedAt,source:'pi-bots-tab-close',
          ...(target.index !== undefined ? {targetIndex:target.index} : {})};
        atomicJson(receipt, {file,request,state:'pending'});
        atomicJson(file, request);
        atomicJson(receipt, {file,request,state:'delivered'});
      }
      if (readJson(receipt)?.state !== 'delivered')
        throw Error(`Original stop delivery is unconfirmed: ${receipt}. Inspect this request before retrying.`);
      requests.push({runId:target.runId,file,receipt});
    }
  }
  return requests;
}
