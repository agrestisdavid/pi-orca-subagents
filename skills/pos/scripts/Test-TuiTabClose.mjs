import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {harness,cwd,readJson,atomicJson,until,orca,delay} from './tui-test-utils.mjs';
import {connect} from '../../../src/tui-host/protocol.mjs';
const variant=process.argv[2]||'default';
const h=await harness('tab-close-'+variant),report={variant,checks:[],runs:[]};
const pass=text=>{report.checks.push(text);atomicJson(path.join(h.root,'result.json'),report);console.log('PASS:',text);};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
try {
 const task='Use todo for your own short plan. Ask contact_supervisor for permission to read README.md and wait for an answer. After approval read only README.md, finish your todo and report TAB_CLOSE_FIXTURE_DONE. Do not start agents.';
 const launch=variant==='parallel'
  ?{cwd,workflowScript:`return await Promise.all([runs.run("alpha",{agent:"scout",context:"fresh",task:${JSON.stringify(task)}}),runs.run("beta",{agent:"scout",context:"fresh",task:${JSON.stringify(task)}})]);`}
  :{cwd,agent:'scout',context:'fresh',task};
 const started=await h.request({action:'start',execution:'orca-tui',coordination:'orca',viewMode:'orca',launch});
 const run={runId:started.details.runId,asyncDir:started.details.asyncDir,coordinationRoot:started.details.coordination.root};
 report.runs.push(run);atomicJson(path.join(h.root,'result.json'),report);
 const mapping=readJson(path.join(run.coordinationRoot,'mapping.json'));
 assert.equal(mapping.tuiViewPolicy,'dispatch-first');
 pass('Shared dispatch is the default without a layout option');
 const count=variant==='parallel'?2:1;
 const children=await until(async()=>{
  await h.request({action:'sync_views',runId:run.runId});
  const values=Array.from({length:count},(_,i)=>readJson(path.join(run.asyncDir,'tui',`child-${i}.json`))).filter(Boolean).map(p=>({...readJson(p.manifest),manifest:p.manifest}));
  return values.length===count&&values.every(v=>v.state==='running')?values:undefined;
 },'running native TUI children');
 report.children=children.map(c=>({manifest:c.manifest,runId:c.runId,pid:c.pid,agentPid:c.agentPid,view:c.view}));
 const shared=children.find(c=>c.view.paneKey===mapping.worker.terminal.paneKey);assert(shared);
 await until(async()=>{const pending=(await h.request({action:'supervisor_pending'})).details.pending;return pending.length===count?pending:undefined;},'blocking supervisor questions');
 if(variant==='parallel') {
  const extra=children.find(c=>c!==shared);
  await orca(['terminal','close','--terminal',extra.view.handle]);
  await until(()=>readJson(extra.manifest)?.tabClose?.completedAt,'additional child native stop and process exit');
  assert.equal(readJson(extra.manifest).tabClose.scope,'child');
  assert.equal(readJson(shared.manifest).state,'running');
  assert.equal(readJson(path.join(run.asyncDir,'status.json')).state,'running');
  pass('Closing an additional tab stops only its child; the shared child keeps running');
 }
 if(variant==='detach') {
  // Change the persisted preference while the child is already running.
  atomicJson(mapping.piBotsSettingsFile,{piBots:{stopOnTabClose:false}});
  await orca(['terminal','close','--terminal',shared.view.handle]);
  await until(()=>readJson(shared.manifest)?.tabClose?.stop===false,'live false setting applied');
  assert.equal(readJson(path.join(run.asyncDir,'status.json')).state,'running');assert(alive(shared.agentPid));
  pass('Disabled close-stop keeps the original native process running');
  await h.request({action:'sync_views',runId:run.runId});
  const attached=await until(()=>{const s=readJson(shared.manifest);return s?.viewState==='attached'?s:undefined;},'same child reattached');
  assert.equal(attached.sessionId,shared.sessionId);assert.equal(attached.agentPid,shared.agentPid);
  pass('sync_views reconnects the same Pi session without another model start');
  const pending=(await h.request({action:'supervisor_pending'})).details.pending;
  await h.request({action:'supervisor_reply',replyTo:pending[0].id,message:'Approved. Read README.md and finish.'});
  await until(()=>readJson(path.join(run.asyncDir,'status.json'))?.state==='complete','native completion after detach');
  atomicJson(mapping.piBotsSettingsFile,{piBots:{stopOnTabClose:true}});
  await orca(['terminal','close','--terminal',attached.view.handle]);
  await until(()=>readJson(shared.manifest)?.tabClose?.completedAt,'completed Pi UI retired on close');
  pass('Changing back to true retires a completed Pi process when its reattached tab closes');
 } else {
  h.close();await delay(500);
  await orca(['terminal','close','--terminal',shared.view.handle]);
  if(variant==='sync-race') {
   await until(()=>readJson(shared.manifest)?.viewState!=='attached','view disconnect observed');
   const control=await connect(shared.manifest);
   try {await assert.rejects(control.call('openView'),/closed|stop|resume/i);} finally {control.close();}
   pass('Immediate sync cannot replace a just-closed tab and bypass native stop');
  }
  await until(()=>readJson(shared.manifest)?.tabClose?.completedAt,'shared native stop and TUI retirement',120000);
  const status=await until(()=>{const s=readJson(path.join(run.asyncDir,'status.json'));return ['stopped','failed','partial'].includes(s?.state)?s:undefined;},'native stopped workflow');
  assert(status.stopped||status.state==='stopped'||status.steps?.some(s=>s.status==='stopped'),JSON.stringify(status));
  pass('Closing the shared tab stops the native workflow even with the parent offline');
 }
 const dispatch=await orca(['orchestration','dispatch-show','--task',mapping.taskId,'--from',mapping.coordinator.terminal.handle]);
 assert.equal(dispatch.dispatch.id,mapping.dispatchId);assert.equal(dispatch.dispatch.termination_reason,'operator_close');
 report.dispatch=dispatch.dispatch;
 pass('Orca records operator_close on the original dispatch without creating a replacement');
 await until(()=>!alive(shared.pid)&&!alive(shared.agentPid),'closed Pi and ConPTY host exited');
 pass('Closed child leaves no Pi process or ConPTY broker running');
}catch(error){report.error=String(error.stack||error);console.error(error);process.exitCode=1;}
finally{atomicJson(path.join(h.root,'result.json'),report);h.close();console.log('Tab-close report:',h.root);}
