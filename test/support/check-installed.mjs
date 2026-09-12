// Copy this probe beside a freshly installed node_modules, then run it there.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
const installRoot=path.dirname(fileURLToPath(import.meta.url));
const pkg=path.join(installRoot,'node_modules/pi-orca-subagents');
const user=path.join(installRoot,'fresh-user');
fs.mkdirSync(user,{recursive:true});
process.env.PI_CODING_AGENT_DIR=user;
const {bundledTodoPath,dedupeBundledTodo}=await import(pathToUrl(path.join(pkg,'src/pos/resources.mjs')));
function pathToUrl(p) {return pathToFileURL(p).href;}
async function load(extra,override) {
 const loader=new DefaultResourceLoader({cwd:user,agentDir:user,settingsManager:SettingsManager.inMemory({}),noExtensions:true,noContextFiles:true,noSkills:false,noPromptTemplates:true,additionalExtensionPaths:extra,additionalSkillPaths:[path.join(pkg,'skills')],extensionsOverride:override});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 return loader;
}
const loader=await load([path.join(pkg,'index.ts')]);
const result=loader.getExtensions();
const names=result.extensions.flatMap(e=>[...e.tools.keys()]);
assert(names.includes('subagent'));assert(names.includes('pi_bots'));assert.equal(names.length,new Set(names).size);
assert(result.extensions.some(e=>e.commands.has('pos')));
assert(loader.getSkills().skills.some(s=>s.name==='pos'));
assert(!fs.existsSync(path.join(installRoot,'node_modules/pi-subagents')));
const todo=await load([bundledTodoPath()]);
assert(todo.getExtensions().extensions.some(e=>e.tools.has('todo')));
const ambient=path.join(user,'extensions/ambient-todo');
fs.cpSync(path.dirname(bundledTodoPath()),ambient,{recursive:true});
const paths=[path.join(ambient,'index.ts'),bundledTodoPath()];
const both=await load(paths,base=>dedupeBundledTodo(base,paths));
assert.equal(both.getExtensions().extensions.filter(e=>e.tools.has('todo')).length,1);
console.log(JSON.stringify({installed:pkg,nativeTools:names.length,pos:true,skill:true,todoWithoutGlobalInstall:true,ambientTodoDeduplicated:true}));
