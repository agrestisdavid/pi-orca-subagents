import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {atomicJson,command} from './orca-adapter.mjs';
import {bridgeStatus} from './orca-bridge.mjs';
const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const agentRoot=path.resolve(scriptDir,'../../..'),cwd=path.resolve(process.env.POS_TEST_CWD || "tests/pi-bots-orca");
const testRoot=fs.mkdtempSync(path.join(cwd,'extension-integration-'));
const stage=path.join(agentRoot, 'extensions',`.pi-bots-orca-${process.pid}.ts`);
process.env.PI_SUBAGENTS_TEMP_ROOT=testRoot;
let mapping;
try {
 fs.writeFileSync(stage,fs.readFileSync(path.join(agentRoot,'extensions/pi-bots.ts'),'utf8').replace('../skills/pos/scripts/orca-bridge.mjs',pathToFileURL(path.join(scriptDir,'orca-bridge.mjs')).href).replace('../skills/pos/scripts/tui-views.mjs',pathToFileURL(path.join(scriptDir,'tui-views.mjs')).href));
 const {default:register}=await import(pathToFileURL(stage));
 const handlers={},listeners=new Map();let tool,startCount=0,nativeRequest;
 const pi={registerTool(t){tool=t;},on(name,fn){handlers[name]=fn;},sendMessage(){},events:{on(name,fn){let set=listeners.get(name);if(!set)listeners.set(name,set=new Set());set.add(fn);return()=>set.delete(fn);},emit(name,req){if(name==='subagents:rpc:v1:request'&&req.method==='spawn'){startCount++;nativeRequest=req;}}}};
 register(pi);
 const ctx={cwd,hasUI:false,sessionManager:{getSessionId:()=>testRoot,getSessionFile:()=>path.join(testRoot,'parent.jsonl')}};
 const abort=new AbortController();
 const promise=tool.execute('start',{action:'start',coordination:'orca',viewMode:'none',launch:{agent:'scout',task:'Synthetic native RPC receipt integration. No AI model is launched.'}},abort.signal,undefined,ctx);
 for(let n=0;n<100&&!nativeRequest;n++)await new Promise(r=>setTimeout(r,500));
 assert(nativeRequest,'native RPC emitted after dispatch proof');assert.equal(startCount,1);abort.abort();
 const cancelled=await promise;assert.equal(cancelled.isError,true);
 assert.equal((await tool.execute('duplicate',{action:'start',launch:{agent:'scout',task:'duplicate'},viewMode:'none'},undefined,undefined,ctx)).isError,true);
 assert.equal(startCount,1);
 const nativeDir=path.join(testRoot,'async-subagent-runs','native-fixture');
 atomicJson(path.join(nativeDir,'status.json'),{runId:'native-fixture',cwd,state:'running',steps:[{agent:'scout',status:'running'}]});
 const data={text:'native fixture launched',details:{runId:'native-fixture',asyncDir:nativeDir}};
 for(const cb of listeners.get('subagents:rpc:v1:reply:'+nativeRequest.requestId))cb({version:1,requestId:nativeRequest.requestId,success:true,data});
 const journals=fs.readdirSync(path.join(testRoot,'pi-bots-state'));
 const journal=JSON.parse(fs.readFileSync(path.join(testRoot,'pi-bots-state',journals[0],'journal.json')));
 const run=journal.runs[0];assert.equal(run.runId,'native-fixture');mapping=bridgeStatus(run.coordinationRoot);
 assert.equal(mapping.nativeRuns.length,1);assert.equal(mapping.nativeRuns[0].runId,'native-fixture');
 handlers.session_shutdown();
 // Adapter remains active and reports completion even after the parent shuts down.
 atomicJson(path.join(nativeDir,'status.json'),{runId:'native-fixture',cwd,state:'complete',steps:[{agent:'scout',status:'completed'}]});
 for(let n=0;n<60&&!bridgeStatus(run.coordinationRoot)?.health?.done;n++)await new Promise(r=>setTimeout(r,500));
 assert.equal(bridgeStatus(run.coordinationRoot).health.done.outcome,'succeeded');
 const tasks=await command(mapping.exe,['orchestration','task-list','--run',mapping.orcaRunId,'--from',mapping.coordinator.terminal.handle,'--json']);
 assert.equal(tasks.data.result.tasks.length,1);assert.equal(tasks.data.result.tasks[0].status,'completed');
 atomicJson(path.join(testRoot,'test-result.json'),{nativeStarts:startCount,mapping:bridgeStatus(run.coordinationRoot),tasks:tasks.data});
 console.log('PASS: extension creates real Orca dispatch before exactly one native RPC; cancellation blocks duplicate; late receipt attaches original run; adapter completes after parent shutdown');
}finally {
 fs.unlinkSync(stage);
 if(mapping?.health?.done||mapping&&bridgeStatus(mapping.root)?.health?.done)for(const ep of [mapping.worker,mapping.coordinator]){
  fs.writeFileSync(path.join(ep.dir,'exit'),'');await command(mapping.exe,['terminal','close','--terminal',ep.terminal.handle,'--json']);
 }
}
