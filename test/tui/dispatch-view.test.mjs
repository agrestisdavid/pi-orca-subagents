import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {claimDispatchView} from '../../src/tui-host/dispatch-view.mjs';
import {atomicJson,readJson} from '../../src/tui-host/protocol.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-shared-dispatch-'));
test('concurrent children reserve exactly one durable dispatch view',async()=>{
 atomicJson(path.join(root,'mapping.json'),{tuiViewPolicy:'dispatch-first'});
 const module=new URL('../../src/tui-host/dispatch-view.mjs',import.meta.url).href;
 const results=await Promise.all(Array.from({length:8},(_,index)=>new Promise((resolve,reject)=>{
  const worker=new Worker(`const {workerData,parentPort}=require('node:worker_threads'); (async()=>{const {claimDispatchView}=await import(workerData.module);parentPort.postMessage(await claimDispatchView(workerData.root,workerData.manifest,{runtime:{runId:'parallel',childIndex:workerData.index},storage:{kind:'memory'}}));})().catch(e=>{throw e});`,{eval:true,workerData:{module,root,index,manifest:path.join(root,`host-${index}.json`)}});
  worker.once('message',resolve);worker.once('error',reject);
 })));
 assert.equal(results.filter(Boolean).length,1);
 const original=readJson(path.join(root,'dispatch-tui.json'));
 assert.equal(await claimDispatchView(root,original.manifest,{runtime:{runId:'parallel',childIndex:original.index}}),true);
 assert.equal(await claimDispatchView(root,path.join(root,'dynamic.json'),{runtime:{runId:'dynamic',childIndex:0}}),false);
});
test('only an exited writer of the same session permits dispatch view resume',async()=>{
 const prior=readJson(path.join(root,'dispatch-tui.json'));
 const sessionFile=path.join(root,'session.jsonl'), next=path.join(root,'resumed.json');
 atomicJson(prior.manifest,{sessionFile,state:'paused'});
 const launch={runtime:{runId:'resumed',childIndex:0},storage:{kind:'file',sessionFile}};
 await assert.rejects(()=>claimDispatchView(root,next,launch),/has not exited/);
 assert.equal(readJson(path.join(root,'dispatch-tui.json')).manifest,prior.manifest);
 atomicJson(prior.manifest,{sessionFile,state:'retired',exitObservedAt:Date.now()});
 assert.equal(await claimDispatchView(root,next,launch),true);
 assert.equal(readJson(path.join(root,'dispatch-tui.json')).previousManifest,prior.manifest);
});
test('existing separate-view workflows keep their original layout',async()=>{
 const legacy=path.join(root,'legacy');fs.mkdirSync(legacy);atomicJson(path.join(legacy,'mapping.json'),{});
 assert.equal(await claimDispatchView(legacy,path.join(legacy,'host.json'),{}),false);
 assert(!fs.existsSync(path.join(legacy,'dispatch-tui.json')));
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
