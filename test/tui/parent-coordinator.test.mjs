import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parentTerminal, bindParentCoordinator} from '../../skills/pos/scripts/parent-coordinator.mjs';
import {tickWorkflow} from '../../skills/pos/scripts/orca-adapter.mjs';
import {atomicJson, readJson} from '../../src/tui-host/protocol.mjs';

const terminal = {handle:'parent',tabId:'tab',leafId:'leaf',connected:true};
const env = {ORCA_TERMINAL_HANDLE:'parent',ORCA_TAB_ID:'tab',ORCA_PANE_KEY:'tab:leaf',ORCA_WORKTREE_ID:'repo::parent',ORCA_AGENT_LAUNCH_TOKEN:'test-token'};

test('coordinator selection uses the actual parent, never the focused or unrelated terminal', () => {
  assert.equal(parentTerminal({}, [terminal]), undefined);
  assert.equal(parentTerminal(env, [{...terminal,handle:'other'},terminal]).handle,'parent');
  for (const list of [[],[terminal,terminal],[{...terminal,connected:false}],[{...terminal,orphaned:true}],[{...terminal,leafId:'wrong'}]])
    assert.throws(() => parentTerminal(env,list),/unavailable or ambiguous/);
  assert.throws(() => parentTerminal({ORCA_TAB_ID:'tab'},[terminal]),/incomplete/);
});

test('parent coordinator starts only a background adapter, preserving ownership across retries', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pos-parent-coordinator-'));
  const calls=[];
  const io={
    command:async (_exe,args)=>{calls.push(args);return {ok:true,data:{result:{terminals:[terminal]}}};},
    ensureBoundAdapter:dir=>{const binding=readJson(path.join(dir,'binding.json'));atomicJson(path.join(dir,'hello.json'),{bindingId:binding.id,identity:binding.identity});},
  };
  try {
    const first=await bindParentCoordinator(root,'orca',env,io);
    const next=await bindParentCoordinator(root,'orca',env,io);
    assert.equal(first.ownedTerminal,false);
    assert.equal(next.terminal.handle,first.terminal.handle);
    assert.deepEqual(calls,[['terminal','list','--json'],['terminal','list','--json']]);
    assert.equal(fs.existsSync(path.join(root,'coordinator','terminal.claim')),false);
    assert.equal(readJson(path.join(first.dir,'binding.json')).env.ORCA_AGENT_LAUNCH_TOKEN,'test-token');
    await assert.rejects(()=>bindParentCoordinator(root,'orca',{},io),/original parent binding is missing/);
    const other={...terminal,handle:'other',tabId:'other-tab'};
    await assert.rejects(()=>bindParentCoordinator(root,'orca',{...env,ORCA_TERMINAL_HANDLE:'other',ORCA_TAB_ID:'other-tab',ORCA_PANE_KEY:'other-tab:leaf'},
      {...io,command:async()=>({ok:true,data:{result:{terminals:[other]}}})}),/another parent/);
    assert.equal(readJson(path.join(first.dir,'endpoint.json')).terminal.handle,'parent');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('a shared parent answers in the question owning Run even after starting another Run', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pos-parent-reply-'));
  try {
    const id=createHash('sha256').update('native-question').digest('hex').slice(0,32);
    const dir=path.join(root,'workflow'),coordinator=path.join(root,'coordinator');
    fs.mkdirSync(dir);
    atomicJson(path.join(root,'mapping.json'),{root,orcaRunId:'original-run',coordinator:{dir:coordinator}});
    atomicJson(path.join(root,'health.json'),{connectionCheckedAt:Date.now(),questions:{'native-question':{messageId:'orca-question'}}});
    atomicJson(path.join(root,'questions',id+'.json'),{id:'native-question',runId:'native-run'});
    atomicJson(path.join(root,'answers',id+'.json'),{confirmedBy:'subagent_supervisor',message:'The actual user answer'});
    await tickWorkflow(dir,'fake',async()=>{throw Error('No new ask or other Orca operation expected');});
    const reply=readJson(path.join(coordinator,'cmd-answer-'+id+'.json'));
    assert.deepEqual(reply.args,['orchestration','reply','--id','orca-question','--run','original-run','--body','[native request native-question] The actual user answer','--json']);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
