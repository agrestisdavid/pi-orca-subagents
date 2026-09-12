import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDirectory, bundledTodoPath, resolveTuiResources, dedupeBundledTodo } from '../../src/pos/resources.mjs';
import pos from '../../src/pos/command.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('Todo belongs to POS and does not need a global Pi installation', () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-empty-'));
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    assert.equal(agentDirectory(), dir);
    assert(fs.existsSync(bundledTodoPath()));
    assert(!bundledTodoPath().startsWith(dir + path.sep));
    assert.throws(resolveTuiResources, /official Pi hooks/);
    fs.mkdirSync(path.join(dir,'extensions'));
    fs.writeFileSync(path.join(dir,'extensions/orca-agent-status.ts'),'export default function () {}');
    const resources = resolveTuiResources();
    assert.equal(resources.agentDir, dir);
    assert.equal(resources.todoExtension, bundledTodoPath());
  } finally {
    if(previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('only a duplicate rpiv Todo is removed; unrelated tools and errors survive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pos-ambient-'));
  try {
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'@juicesharp/rpiv-todo'}));
    const own={resolvedPath:bundledTodoPath(),tools:new Map([['todo',{}]])};
    const ambient={resolvedPath:path.join(dir,'index.ts'),tools:new Map([['todo',{}]])};
    const other={resolvedPath:path.join(dir,'other/index.ts'),tools:new Map([['read',{}]])};
    const errors=[{path:'missing.ts',error:'visible'}];
    const base={extensions:[ambient,own,other],errors};
    assert.deepEqual(dedupeBundledTodo(base,[bundledTodoPath()]).extensions,[own,other]);
    assert.equal(dedupeBundledTodo(base,[bundledTodoPath()]).errors,errors);
    assert.equal(dedupeBundledTodo(base,[]),base);
    const failed={extensions:[ambient],errors};
    assert.equal(dedupeBundledTodo(failed,[bundledTodoPath()]),failed);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('/pos forwards the exact task with Orca defaults and shows help without a model turn', async () => {
  const commands=new Map(),messages=[],notices=[];
  pos({registerCommand:(name,definition)=>commands.set(name,definition),sendUserMessage:(...args)=>messages.push(args)});
  const ctx={ui:{notify:(...args)=>notices.push(args)}};
  await commands.get('pos').handler('',ctx);
  assert.equal(messages.length,0);assert.match(notices[0][0],/\/pos/);
  const task='Inspect only README.md. Use headless if explicitly selected.';
  await commands.get('pos').handler(task,ctx);
  assert(messages[0][0].endsWith(task));assert.match(messages[0][0],/execution: "orca-tui"/);
  assert.match(messages[0][0],/Todo installation is required/);
});

test('one package loads native and Orca tools plus POS without global packages', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pos-loader-'));
  const previous=process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR=dir;
    const pi=await import('@earendil-works/pi-coding-agent');
    const loader=new pi.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:pi.SettingsManager.inMemory({}),noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,additionalExtensionPaths:[path.join(root,'index.ts')]});
    await loader.reload();
    const result=loader.getExtensions();
    assert.deepEqual(result.errors,[]);
    const toolNames=result.extensions.flatMap(e=>[...e.tools.keys()]);
    assert(toolNames.includes('subagent'));assert(toolNames.includes('pi_bots'));
    assert.equal(toolNames.length,new Set(toolNames).size);
    assert(result.extensions.some(e=>e.commands.has('pos')));
    const todoLoader=new pi.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:pi.SettingsManager.inMemory({}),noExtensions:true,noSkills:true,noContextFiles:true,additionalExtensionPaths:[bundledTodoPath()]});
    await todoLoader.reload();
    assert.deepEqual(todoLoader.getExtensions().errors,[]);
    assert(todoLoader.getExtensions().extensions.some(e=>e.tools.has('todo')));
  } finally {
    if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
