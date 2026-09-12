// No model calls. Probe the original unsupervised dispatch after its pane closes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {cwd,readJson,atomicJson,until,orca} from './tui-test-utils.mjs';
import {prepareWorkflow,attachNative} from './orca-bridge.mjs';
import {ensureBoundAdapter} from './orca-adapter.mjs';
const root=path.join(cwd,'dispatch-pane-closure-'+Date.now()), report={checks:[]};
let map;
try {
 map=await prepareWorkflow(root,cwd,{task:'Model-free probe: close the assigned shell pane and verify whether the original dispatch can still report its synthetic completion.'});
 const native=path.join(root,'synthetic-native');
 atomicJson(path.join(native,'status.json'),{runId:'synthetic-closure',cwd,state:'running'});
 attachNative(root,{runId:'synthetic-closure',asyncDir:native},path.join(root,'supervisor'));
 await until(()=>readJson(path.join(root,'health.json'))?.connected,'connected');
 await orca(['terminal','close','--terminal',map.worker.terminal.handle]);
 const closed=await orca(['orchestration','dispatch-show','--task',map.taskId,'--from',map.coordinator.terminal.handle]);
 assert.equal(closed.dispatch.status,'failed');assert.equal(closed.dispatch.termination_reason,'operator_close');
 report.dispatch=closed;report.checks.push('Closing the pane explicitly aborts its original Orca dispatch');
 atomicJson(path.join(native,'status.json'),{runId:'synthetic-closure',cwd,state:'complete'});
 ensureBoundAdapter(map.worker.dir,map.exe);
 const rejected=await until(()=>readJson(path.join(map.worker.dir,'reply-done.json')),'completion rejection after pane closure',30000);
 assert.equal(rejected.data.error.code,'inactive_dispatch');
 report.completionRejection=rejected.data.error;
 report.checks.push('Restoring the exact adapter cannot revive the aborted dispatch');
 assert.equal(report.dispatch.dispatch.id,map.dispatchId);
 for(const check of report.checks) console.log('PASS:',check);
}catch(error){report.error=String(error.stack||error);console.error(error);process.exitCode=1;}
finally {
 report.mapping=map && {taskId:map.taskId,dispatchId:map.dispatchId,orcaRunId:map.orcaRunId,worker:map.worker.terminal};
 atomicJson(path.join(root,'result.json'),report);
 // Keep a failed probe's adapter and receipts available for precise recovery.
 if(map && !report.error)for(const role of ['coordinator','worker']) {
  fs.writeFileSync(path.join(map[role].dir,'exit'),'');
  await orca(['terminal','close','--terminal',map[role].terminal.handle]).catch(()=>{});
 }
 console.log('Closure probe:',path.join(root,'result.json'));
}
