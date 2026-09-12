import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {atomicJson,executeOnce,tickWorkflow} from './orca-adapter.mjs';
import {bridgeStatus} from './orca-bridge.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-bots-recovery-test-'));
const original=['orchestration','task-create','--spec','original request','--json'];
try {
 let calls=[];
 const success=async(exe,args)=>{calls.push(args);return {ok:true,data:{ok:true,result:{task:{id:'task-original'}}}};};
 await executeOnce(root,'once',original,'fake',success);await executeOnce(root,'once',original,'fake',success);assert.equal(calls.length,1);
 await assert.rejects(()=>executeOnce(root,'once',['different'],'fake',success),/Conflicting/);
 fs.writeFileSync(path.join(root,'cmd-crashed.json.claimed'),'');
 assert.equal((await executeOnce(root,'crashed',original,'fake',success)).uncertain,true);assert.equal(calls.length,1);
 const unknown={ok:false,data:{error:{data:{recovery:{orchestrationRequestId:'original-orca-request'}}}}};
 atomicJson(path.join(root,'reply-recover.json'),unknown);
 const recover=async(exe,args)=>{calls.push(args);return args[1]==='request-show'?{ok:true,data:{result:{state:'pending'}}}:{ok:true,data:{result:{task:{id:'replayed-original'}}}};};
 const receipt=await executeOnce(root,'recover',original,'fake',recover);
 assert.equal(receipt.data.result.task.id,'replayed-original');assert.equal(calls[1][1],'request-show');
 assert.deepEqual(calls[2],[...original,'--retry-request','original-orca-request']);
 atomicJson(path.join(root,'reply-absent.json'),unknown);
 const absent=async(exe,args)=>{assert.equal(args[1],'request-show');return {ok:true,data:{result:{state:'absent'}}};};
 assert.equal((await executeOnce(root,'absent',original,'fake',absent)).ok,false);
 atomicJson(path.join(root,'mapping.json'),{root});atomicJson(path.join(root,'health.json'),{connected:true,updatedAt:Date.now()-61000});
 assert.equal(bridgeStatus(root).health.connected,false);
 // An unavailable Orca executable affects only its bridge health. No native
 // stop/control file is created and the original native status stays running.
 const nativeDir=path.join(root,'native'),workflow=path.join(root,'workflow');fs.mkdirSync(workflow);
 atomicJson(path.join(root,'mapping.json'),{root,taskId:'task',dispatchId:'dispatch',worker:{terminal:{handle:'own'}},coordinator:{dir:path.join(root,'coordinator')}});
 atomicJson(path.join(root,'native-link.json'),{runs:[{runId:'native',asyncDir:nativeDir}],current:{runId:'native',asyncDir:nativeDir}});
 atomicJson(path.join(nativeDir,'status.json'),{runId:'native',state:'running'});
 await tickWorkflow(workflow,path.join(root,'missing-orca.exe'));
 assert.equal(bridgeStatus(root).health.connected,false);assert.equal(JSON.parse(fs.readFileSync(path.join(nativeDir,'status.json'))).state,'running');
 assert.deepEqual(fs.readdirSync(nativeDir),['status.json']);
 // Orca status can exit zero and return ok:true while the desktop is down.
 // Treat runtime reachability as authoritative and do not send queued work.
 let statusCalls=0;
 const unavailable=async(exe,args)=>{statusCalls++;assert.deepEqual(args,['status','--json']);return {ok:true,code:0,data:{ok:true,result:{runtime:{reachable:false,state:'stale_bootstrap'}}}};};
 await tickWorkflow(workflow,'fake',unavailable);
 assert.equal(statusCalls,1);assert.equal(bridgeStatus(root).health.connected,false);
 assert.match(bridgeStatus(root).health.error,/runtime is unavailable.*stale_bootstrap/);
 assert.deepEqual(fs.readdirSync(nativeDir),['status.json']);
 // Recovery resumes the original bridge without creating a replacement run.
 const reachable=async(exe,args)=>({ok:true,data:{ok:true,result:args[0]==='status'?{runtime:{reachable:true,state:'ready'}}:{}}});
 await tickWorkflow(workflow,'fake',reachable);
 assert.equal(bridgeStatus(root).health.connected,true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(nativeDir,'status.json'))).state,'running');
 console.log('PASS: adapter receipt replay, crash fail-closed, query before keyed recovery, no retry for absent request, stale/disconnected health, native run survives Orca failure');
}finally{fs.rmSync(root,{recursive:true,force:true});}
