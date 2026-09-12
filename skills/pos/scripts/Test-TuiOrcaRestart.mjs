// Root operator restarts the entire desktop only after restart-ready.json.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {harness,cwd,readJson,atomicJson,until,orca,delay} from './tui-test-utils.mjs';
const h=await harness('orca-desktop-restart'),report={checks:[]},file=path.join(h.root,'result.json');
const pass=name=>{report.checks.push(name);console.log('PASS:',name);atomicJson(file,report);};
try{
 const task='Use todo to create your own short plan. Ask contact_supervisor for permission to read README.md and wait for the answer. A desktop restart test is in progress; keep waiting patiently. After approval read README.md, complete your todo and report ORCA_RESTART_CONFIRMED plus its sentence. Do not start other agents.';
 const r=await h.request({action:'start',execution:'orca-tui',coordination:'orca',viewMode:'orca',launch:{cwd,workflowScript:`return runs.run("restart-scout",{agent:"scout",context:"fresh",task:${JSON.stringify(task)}});`}});
 const run={runId:r.details.runId,asyncDir:r.details.asyncDir,coordinationRoot:r.details.coordination.root};report.run=run;atomicJson(file,report);
 const question=await until(async()=>{await h.request({action:'sync_views',runId:run.runId});return (await h.request({action:'supervisor_pending'})).details.pending[0];},'native question');
 const pointer=readJson(path.join(run.asyncDir,'tui','child-0.json')),before=readJson(pointer.manifest);
 const map=readJson(path.join(run.coordinationRoot,'mapping.json'));report.sessionId=before.sessionId;report.agentPid=before.agentPid;report.dispatchId=map.dispatchId;report.oldRuntime=(await orca(['status'])).runtime.runtimeId;
 await until(()=>Object.keys(readJson(path.join(run.coordinationRoot,'health.json'))?.questions||{}).length===1,'Orca question notification');
 atomicJson(path.join(h.root,'restart-ready.json'),{run,manifest:pointer.manifest,question,agentPid:before.agentPid,hostPid:before.pid,sessionId:before.sessionId,oldRuntime:report.oldRuntime});
 console.log('READY FOR AUTHORIZED ORCA RESTART:',h.root);
 await until(()=>readJson(path.join(h.root,'desktop-restarted.json')),'operator desktop restart',600000);
 const outage=readJson(path.join(h.root,'desktop-outage.json'));assert.equal(outage?.health?.connected,false);assert.equal(outage.samePiPid,true);report.outage=outage;pass('Actual desktop outage is reported disconnected while the original Pi continues');
 const live=readJson(pointer.manifest);assert.equal(live.agentPid,before.agentPid);assert.equal(live.pid,before.pid);assert.equal(live.sessionId,before.sessionId);process.kill(live.agentPid,0);pass('Whole Orca desktop exit preserves the exact native Pi process, PTY host and session');
 const current=(await orca(['status'])).runtime.runtimeId;assert.notEqual(current,report.oldRuntime);report.newRuntime=current;pass('Orca is running as a newly started runtime');
 const views=await h.request({action:'sync_views',runId:run.runId});atomicJson(path.join(h.root,'restored-views.json'),views);
 if(views.details.views.coordination?.restoreError)throw Error(views.details.views.coordination.restoreError);
 const restored=await until(async()=>{const host=readJson(pointer.manifest);if(host.viewState!=='attached')return;const shown=await orca(['terminal','show','--terminal',host.view.handle]);return shown.terminal.agentIdentity==='pi'?host:undefined;},'same Pi reattachment',90000);
 assert.equal(restored.agentPid,before.agentPid);pass('Reopened child tab registers the same live Pi session with the new Orca runtime');
 await h.request({action:'supervisor_reply',replyTo:question.id,message:'Approved: Orca has restarted. Read README.md and finish.'});
 const status=await until(()=>{const s=readJson(path.join(run.asyncDir,'status.json'));return ['complete','failed','stopped','partial'].includes(s?.state)?s:undefined;},'native completion');assert.equal(status.state,'complete',status.error);
 const done=await until(()=>readJson(path.join(run.coordinationRoot,'health.json'))?.done,'original dispatch completion',60000);assert.equal(done.outcome,'succeeded');pass('Original native question, answer and workflow result settle after the desktop outage');
 const updated=readJson(path.join(run.coordinationRoot,'mapping.json'));const dispatch=await orca(['orchestration','dispatch-show','--task',updated.taskId,'--from',updated.coordinator.terminal.handle]);assert.equal(dispatch.dispatch.id,map.dispatchId);assert.equal(updated.nativeRuns.length,1);report.dispatch=dispatch;pass('Desktop restart creates no additional workflow dispatch or native start');
}catch(error){report.error=String(error.stack||error);console.error(error);process.exitCode=1;}
finally{atomicJson(file,report);h.close();console.log('Desktop-restart report:',file);}
