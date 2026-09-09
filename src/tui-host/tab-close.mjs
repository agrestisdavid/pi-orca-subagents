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
