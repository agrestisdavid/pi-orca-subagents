import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stopOnTabClose,tabPresence,requestTabStop} from '../../src/tui-host/tab-close.mjs';
import {atomicJson,readJson} from '../../src/tui-host/protocol.mjs';
test('Closing defaults to stop; false and invalid settings cannot become true',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-close-policy-'));
 try {
  const file=path.join(root,'settings.json');
  assert.equal(stopOnTabClose(file),true);
  atomicJson(file,{piBots:{stopOnTabClose:false}});assert.equal(stopOnTabClose(file),false);
  atomicJson(file,{piBots:{stopOnTabClose:'false'}});assert.throws(()=>stopOnTabClose(file));
  fs.writeFileSync(file,'{');assert.throws(()=>stopOnTabClose(file));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('Runtime outage, failed inventory and restart are not tab closes',()=>{
 const view={tabId:'tab',paneKey:'tab:leaf'},empty={terminals:[]};
 assert.equal(tabPresence({reachable:false},empty,view,'a'),'unknown');
 assert.equal(tabPresence({reachable:true,runtimeId:'a'},undefined,view,'a'),'unknown');
 assert.equal(tabPresence({reachable:true,runtimeId:'b'},empty,view,'a'),'unknown');
 assert.equal(tabPresence({reachable:true,runtimeId:'a'},empty,view,'a'),'missing');
 assert.equal(tabPresence({reachable:true,runtimeId:'b'},{terminals:[{...view,handle:'new'}]},view,'a'),'present');
});
test('Native stop targets only the owning child and does not redeliver consumed requests',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-close-delivery-'));
 try {
  const root=path.join(dir,'tui','attempt'),coordinationRoot=path.join(dir,'coord');
  atomicJson(path.join(dir,'status.json'),{runId:'run',state:'running'});
  atomicJson(path.join(coordinationRoot,'mapping.json'),{worker:{terminal:{paneKey:'dispatch'}}});
  const host={root,runId:'run',index:2,coordinationRoot,view:{paneKey:'child'},tabClose:{requestId:'close-original',confirmedAt:123}};
  const first=requestTabStop(host,{});assert.equal(readJson(first[0].file).targetIndex,2);
  fs.rmSync(first[0].file);requestTabStop(host,{});assert(!fs.existsSync(first[0].file));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
