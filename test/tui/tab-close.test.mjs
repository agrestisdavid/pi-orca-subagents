import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stopOnTabClose,tabPresence,requestTabStop,workspaceForView,isDispatchView,createAbsenceTracker} from '../../src/tui-host/tab-close.mjs';
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
test("Existence checks use the correct workspace per tab (create-beta regression)",()=>{
 // The assigned dispatch tab belongs to the workflow area; the child works in
 // its own worktree. The old code queried the child launch directory and
 // misread the shared dispatch tab as closed.
 // Live-acceptance regression: mapping.worker.dir is the adapter's state
 // directory (not an Orca-known workspace) — the dispatch view must probe
 // mapping.cwd, the worktree where the dispatch terminal was created.
 const mapping={cwd:'C:/repo',worker:{dir:'C:/state/workflows/wf/workflow',terminal:{paneKey:'dispatch'}}};
 const launchCwd='C:/repo-beta-0.3.5';
 assert.equal(isDispatchView({dispatchView:true,view:{paneKey:'dispatch'}},mapping),true);
 assert.equal(workspaceForView({dispatchView:true,view:{paneKey:'dispatch'}},mapping,launchCwd),'C:/repo');
 // A separately created child tab is checked in its own launch directory.
 assert.equal(isDispatchView({dispatchView:true,view:{paneKey:'child'}},mapping),false);
 assert.equal(workspaceForView({dispatchView:true,view:{paneKey:'child'}},mapping,launchCwd),launchCwd);
 assert.equal(workspaceForView({dispatchView:false,view:{paneKey:'child'}},mapping,launchCwd),launchCwd);
 // Without a worker entry at all the workflow cwd identifies the area.
 assert.equal(workspaceForView({dispatchView:true,view:{paneKey:'dispatch'}},{cwd:'C:/repo',worker:{terminal:{paneKey:'dispatch'}}},launchCwd),'C:/repo');
 // Same identity in the right inventory is present; in the other worktree's
 // inventory it must not be misread as closed by the tracker.
 const view={tabId:'tab',paneKey:'tab:leaf',handle:'h'};
 const tracker=createAbsenceTracker('rt-1');
 assert.equal(tabPresence({reachable:true,runtimeId:'rt-1'},{terminals:[view]},view,tracker.runtime()),'present');
 assert.equal(tracker.probe('present','rt-1'),'present');
 assert.equal(tracker.probe('missing','rt-1'),'pending');
 assert.equal(tracker.probe('missing','rt-1'),'absent');
});
test('Two consecutive confirmed absences prove a close; unknown breaks the streak',()=>{
 const tracker=createAbsenceTracker('rt-1');
 assert.equal(tracker.probe('missing','rt-1'),'pending');
 // Runtime switch in between: absence in the new runtime is unknown and
 // resets the confirmed-absence streak.
 assert.equal(tracker.probe('unknown'),'unknown');
 assert.equal(tracker.probe('missing'),'pending');
 assert.equal(tracker.probe('missing'),'absent');
 const fresh=createAbsenceTracker('rt-1');
 fresh.probe('missing','rt-1');
 assert.equal(fresh.probe('present','rt-2'),'present');
 assert.equal(fresh.runtime(),'rt-2');
 assert.equal(fresh.probe('missing'),'pending');
 const detached=createAbsenceTracker('rt-1');
 detached.probe('missing','rt-1');
 detached.markObserved('rt-3');
 assert.equal(detached.runtime(),'rt-3');
 assert.equal(detached.probe('missing'),'pending');
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
