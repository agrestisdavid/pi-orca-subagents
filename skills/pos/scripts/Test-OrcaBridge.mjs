import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareWorkflow, attachNative, confirmNativeReply, bridgeStatus } from './orca-bridge.mjs';
import { atomicJson, command } from './orca-adapter.mjs';
const cwd=path.resolve(process.env.POS_TEST_CWD || "tests/pi-bots-orca");
const root=path.join(cwd,process.argv[2]||'bridge-integration');
const report=[];
const wait=async(test,label)=>{for(let n=0;n<60;n++){const value=test();if(value)return value;await new Promise(r=>setTimeout(r,500));}throw Error('Timed out: '+label);};
for(const state of process.argv[3]?process.argv[3].split(','):['complete','failed','stopped']) {
 const dir=path.join(root,state);
 if(fs.existsSync(path.join(dir,'mapping.json')))throw Error('Test already has a dispatch; choose a new test root, never overwrite its journal.');
 const mapping=await prepareWorkflow(dir,cwd,{task:`Adapter integration fixture: ${state}. Native execution is simulated; this test checks the real Orca protocol.`});
 const nativeDir=path.join(dir,'native'),supervisorRoot=path.join(dir,'supervisor');fs.mkdirSync(nativeDir,{recursive:true});
 const runId=`fixture-${state}`;
 atomicJson(path.join(nativeDir,'status.json'),{runId,state:'running',steps:[{agent:'scout',status:'running'},{agent:'reviewer',status:'running'}]});
 attachNative(dir,{runId,asyncDir:nativeDir},supervisorRoot);
 if(state==='complete') {
   const req={id:'native-request-1',runId,childIndex:1,agent:'reviewer',expectsReply:true,message:'Use result A?',expiresAt:Date.now()+90000};
   atomicJson(path.join(supervisorRoot,'channel','requests','request.json'),req);
   await wait(()=>bridgeStatus(dir)?.health?.questions?.[req.id], 'native question mirror');
   confirmNativeReply(dir,req.id,'A confirmed by the native supervisor fixture');
   // Complete immediately after native confirmation: worker_done must wait for
   // the coordinator's answer receipt, even when the child exits first.
   // A later, dynamically materialized child never creates a second dispatch.
   atomicJson(path.join(nativeDir,'status.json'),{runId,state:'running',steps:[{agent:'scout'},{agent:'reviewer'},{agent:'worker'}]});
 }
 atomicJson(path.join(nativeDir,'status.json'),{runId,state,steps:[{agent:'scout',status:state==='complete'?'completed':state}]});
 const health=await wait(()=>bridgeStatus(dir)?.health?.done,'worker_done '+state);
 if(state==='complete')assert.equal(bridgeStatus(dir).health.questions['native-request-1'].answered,true);
 assert.equal(health.outcome,state==='complete'?'succeeded':'failed');
 const tasks=await command(mapping.exe,['orchestration','task-list','--run',mapping.orcaRunId,'--from',mapping.coordinator.terminal.handle,'--json']);
 const proof=await command(mapping.exe,['orchestration','dispatch-show','--task',mapping.taskId,'--json']);
 assert.equal(tasks.data.result.tasks.length,1);assert.equal(proof.data.result.dispatch.id,mapping.dispatchId);
 assert.equal(proof.data.result.dispatch.assignee_pane_key,mapping.worker.terminal.paneKey);
 report.push({state,orcaRunId:mapping.orcaRunId,taskId:mapping.taskId,dispatchId:mapping.dispatchId,health,tasks:tasks.data,proof:proof.data});
 atomicJson(path.join(root,'results.json'),report);
 // Only test-owned, settled model-free endpoints are closed.
 for(const ep of [mapping.worker,mapping.coordinator]) {
   fs.writeFileSync(path.join(ep.dir,'exit'),'');
   await command(mapping.exe,['terminal','close','--terminal',ep.terminal.handle,'--json']);
 }
 console.log(`PASS: real Orca ${state} dispatch, exact terminal identity, one workflow task`);
}
