import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {harness,cwd,readJson,atomicJson,until,orca} from './tui-test-utils.mjs';
const h=await harness('shared-dispatch'), report={checks:[]};
const pass=name=>{report.checks.push(name);atomicJson(path.join(h.root,'result.json'),report);console.log('PASS:',name);};
try {
 const before=await orca(['terminal','list','--worktree','path:'+cwd]);
 const started=await h.request({action:'start',execution:'orca-tui',coordination:'orca',viewMode:'orca',launch:{agent:'scout',context:'fresh',cwd,task:'Use todo to create your own plan. Ask contact_supervisor for permission to read README.md and wait for the answer. After approval, read only README.md, finish your todos and answer SHARED_DISPATCH_CONFIRMED with the fixture sentence. Do not start other agents.'}});
 const run={runId:started.details.runId,asyncDir:started.details.asyncDir,coordinationRoot:started.details.coordination.root};report.runs=[run];
 atomicJson(path.join(h.root,'result.json'),report);
 const pointer=await until(()=>readJson(path.join(run.asyncDir,'tui','child-0.json')),'child pointer');
 const host=await until(()=>{const v=readJson(pointer.manifest);return v?.sessionId?v:undefined;},'actual Pi session');
 const mapping=readJson(path.join(run.coordinationRoot,'mapping.json'));
 assert.equal(host.view.handle,mapping.worker.terminal.handle);assert.equal(host.view.paneKey,mapping.worker.terminal.paneKey);
 pass('The real child TUI occupies the original dispatch pane');
 const after=await orca(['terminal','list','--worktree','path:'+cwd]);
 const newTabs=after.terminals.filter(t=>!before.terminals.some(p=>p.handle===t.handle));report.newTabs=newTabs.map(t=>({handle:t.handle,tabId:t.tabId,agentIdentity:t.agentIdentity}));
 assert.equal(newTabs.length,2);pass('Single child creates only coordinator plus shared dispatch/Pi tab');
 await until(async()=>{const shown=await orca(['terminal','show','--terminal',host.view.handle]);return shown.terminal.agentIdentity==='pi';},'official Pi recognition',30000);
 pass('Orca recognizes Pi in the dispatch pane');
 const question=await until(async()=>{const health=readJson(path.join(run.coordinationRoot,'health.json'));if(health?.connected===false)throw Error(health.error);return (await h.request({action:'supervisor_pending'})).details.pending[0];},'native supervisor question');
 await until(()=>readJson(path.join(run.coordinationRoot,'health.json'))?.questions?.[question.id],'Orca question');
 const dispatch=await orca(['orchestration','dispatch-show','--task',mapping.taskId,'--from',mapping.coordinator.terminal.handle]);
 assert.equal(dispatch.dispatch.id,mapping.dispatchId);assert.equal(dispatch.dispatch.status,'dispatched');
 pass('Pi session registration preserves the confirmed workflow dispatch');
 await orca(['terminal','send','--terminal',host.view.handle,'--text','/bot-reply Approved: read README.md and finish.','--enter']);
 const status=await until(()=>{const s=readJson(path.join(run.asyncDir,'status.json'));return ['complete','failed','stopped','partial'].includes(s?.state)?s:undefined;},'native result');
 assert.equal(status.state,'complete',status.error);
 const done=await until(()=>{const health=readJson(path.join(run.coordinationRoot,'health.json'));if(health?.connected===false)throw Error(health.error);return health?.done;},'original dispatch completion');
 assert.equal(done.outcome,'succeeded');pass('Question, TUI reply, todo and original dispatch completion work in the shared pane');
 const text=fs.readFileSync(host.sessionFile,'utf8');assert(text.includes('SHARED_DISPATCH_CONFIRMED'));assert(text.includes('"toolName":"todo"'));
 report.sessionId=host.sessionId;report.manifest=pointer.manifest;report.dispatchId=mapping.dispatchId;
 report.dispatch=await orca(['orchestration','dispatch-show','--task',mapping.taskId,'--from',mapping.coordinator.terminal.handle]);
} catch(error) {report.error=String(error.stack||error);console.error(error);process.exitCode=1;}
finally {atomicJson(path.join(h.root,'result.json'),report);h.close();console.log('Shared dispatch report:',h.root);}
