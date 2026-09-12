// Run from a disposable Orca terminal. The parent harness makes no model calls;
// the two named local children perform small, sequential live checks.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {harness,cwd,readJson,atomicJson,until,orca,delay} from './tui-test-utils.mjs';
import {recoverWorkflowAdapters} from './orca-bridge.mjs';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
assert(process.env.ORCA_TERMINAL_HANDLE,'Run inside its own Orca test terminal.');
const h=await harness('parent-dispatch'), report={checks:[],runs:[]};
const reportFile=path.join(h.root,'result.json');
const pass=name=>{report.checks.push(name);atomicJson(reportFile,report);console.log('PASS:',name);};
try {
  const baseline=await orca(['terminal','list','--worktree','path:'+cwd]);
  for (const agent of ['local-scout','local-delegate']) {
    const start=await h.request({action:'start',execution:'orca-tui',coordination:'orca',viewMode:'orca',dispatchView:'shared',
      launch:{agent,context:'fresh',cwd,task:agent==='local-scout'
        ? 'Create and complete one short todo for this test, then answer only POS_TAB_ONE. No other tools or files.'
        : 'Create one short todo. Ask contact_supervisor exactly "May I finish the POS tab test?" with timeoutMs 120000 and wait for its answer. Then complete your todo and answer only POS_TAB_TWO. No file changes or other tools.'}});
    const run={runId:start.details.runId,asyncDir:start.details.asyncDir,coordinationRoot:start.details.coordination.root};
    report.runs.push(run);atomicJson(reportFile,report);
    const pointer=await until(()=>readJson(path.join(run.asyncDir,'tui','child-0.json')),'child pointer');
    const host=await until(()=>{const v=readJson(pointer.manifest);return v?.sessionId?v:undefined;},'real child session');
    const mapping=readJson(path.join(run.coordinationRoot,'mapping.json'));
    assert.equal(mapping.coordinator.ownedTerminal,false);
    assert.equal(mapping.coordinator.terminal.handle,process.env.ORCA_TERMINAL_HANDLE);
    assert.equal(host.view.handle,mapping.worker.terminal.handle);
    assert.equal(host.view.tabId,mapping.worker.terminal.tabId);
    assert.match(host.modelId,/^(llama-server=|local)/);
    const listed=await orca(['terminal','list','--worktree','path:'+cwd]);
    assert.equal(listed.terminals.filter(t=>!baseline.terminals.some(b=>b.handle===t.handle)).length,report.runs.length);
    pass(agent+': exactly one new tab, actual local child in its assigned dispatch');
    if (agent==='local-delegate') {
      const old=readJson(path.join(mapping.coordinator.dir,'hello.json'));
      process.kill(old.pid);
      await delay(500);
      await recoverWorkflowAdapters(run.coordinationRoot);
      assert.notEqual(readJson(path.join(mapping.coordinator.dir,'hello.json')).pid,old.pid);
      pass('Parent coordinator adapter recovers without terminal input or a new tab');
      const question=await until(async()=> (await h.request({action:'supervisor_pending'})).details.pending[0],'native question',180000);
      await until(()=>readJson(path.join(run.coordinationRoot,'health.json'))?.questions?.[question.id],'Orca question',30000);
      await h.request({action:'supervisor_reply',replyTo:question.id,message:'Yes. Finish the POS tab test.'});
      await until(()=>readJson(path.join(run.coordinationRoot,'health.json'))?.questions?.[question.id]?.answered,'confirmed coordinator answer',30000);
      pass('Question and reply route through the actual parent coordinator');
    }
    const status=await until(()=>{const s=readJson(path.join(run.asyncDir,'status.json'));return ['complete','failed','stopped','partial'].includes(s?.state)?s:undefined;},'local completion',180000);
    assert.equal(status.state,'complete',JSON.stringify(status.error||status.steps?.map(s=>s.error)));
    const done=await until(()=>readJson(path.join(run.coordinationRoot,'health.json'))?.done,'Orca completion',30000);
    assert.equal(done.outcome,'succeeded');
    pass(agent+': original dispatch finishes successfully');
  }
} catch(error) {report.error=String(error.stack||error);console.error(error);process.exitCode=1;}
finally {atomicJson(reportFile,report);h.close();console.log('Parent dispatch report:',h.root);}
