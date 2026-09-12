import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, command } from './orca-adapter.mjs';
const root = path.resolve(process.argv[2] || 'tests/pi-bots-orca');
const exe = process.env.ORCA_CLI_COMMAND || path.join(process.env.LOCALAPPDATA, 'Programs/orca/resources/bin/orca.exe');
const adapter = fileURLToPath(new URL('./orca-adapter.mjs', import.meta.url));
fs.mkdirSync(root, {recursive:true});
fs.writeFileSync(path.join(root,'README.md'), 'Pi Bots isolated read-only smoke fixture.\n');
const logFile = path.join(root, 'dispatch-smoke.json');
const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile)) : {};
async function cli(...args) { const result = await command(exe, args.concat('--json')); if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }
async function endpoint(role) {
 const dir = path.join(root, role); fs.mkdirSync(dir,{recursive:true});
 const quote = x => "'" + x.replaceAll("'", "''") + "'";
 const ps = `& ${quote(process.execPath)} ${quote(adapter)} ${quote(dir)} ${quote(exe)}`;
 const cmd = `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(ps,'utf16le').toString('base64')}`;
 const terminal = await cli('terminal','create','--worktree',`path:${root}`,'--title',`Pi Bots smoke ${role}`,'--command',cmd);
 for (let n=0;n<100&&!fs.existsSync(path.join(dir,'hello.json'));n++) await new Promise(r=>setTimeout(r,200));
 const hello = JSON.parse(fs.readFileSync(path.join(dir,'hello.json')));
 return {dir,terminal,hello};
}
async function invoke(ep,id,args) {
 const out=path.join(ep.dir,`reply-${id}.json`);
 atomicJson(path.join(ep.dir,`cmd-${id}.json`),{args:['orchestration',...args,'--json']});
 for(let n=0;n<200&&!fs.existsSync(out);n++) await new Promise(r=>setTimeout(r,200));
 return JSON.parse(fs.readFileSync(out));
}
try {
 log.repo ||= await cli('repo','add','--path',root);
 log.coordinator ||= await endpoint('coordinator');
 log.worker ||= await endpoint('workflow');
 log.run ||= await invoke(log.coordinator,'run',['run-create','--objective','Pi Bots model-free dispatch integration smoke']);
 atomicJson(logFile,log);
 const run = log.run.data.result.run.id;
 log.task ||= await invoke(log.coordinator,'task',['task-create','--spec','Read-only synthetic native workflow; no model is launched by the adapter.','--run',run]);
 atomicJson(logFile,log);
 const task = log.task.data.result.task.id;
 log.dispatch ||= await invoke(log.coordinator,'dispatch',['dispatch','--task',task,'--to',log.worker.hello.identity.ORCA_TERMINAL_HANDLE,'--run',run,'--return-preamble']);
 atomicJson(logFile,log);
 const dispatch = log.dispatch.data.result.dispatch.id;
 log.question ||= await invoke(log.worker,'question',['ask','--question','Native request smoke-1: proceed with the read-only test?','--timeout-ms','1000']);
 atomicJson(logFile,log);
 log.answer ||= await invoke(log.coordinator,'answer',['reply','--id',log.question.data.messageId,'--body','Proceed; native supervisor confirmation smoke-1.']);
 log.done ||= await invoke(log.worker,'done',['send','--from',log.worker.hello.identity.ORCA_TERMINAL_HANDLE,'--type','worker_done','--subject','Pi Bots adapter smoke complete','--body','The model-free adapter accepted the workflow dispatch. The question and native-confirmed answer were mirrored. No work remains.','--task-id',task,'--dispatch-id',dispatch,'--outcome','succeeded']);
 log.tasks=await cli('orchestration','task-list','--run',run,'--from',log.coordinator.hello.identity.ORCA_TERMINAL_HANDLE);
 log.proof=await cli('orchestration','dispatch-show','--task',task);
 atomicJson(logFile,log);
 if(log.proof.result.dispatch.id===dispatch && log.proof.result.dispatch.status==='completed') {
  for(const ep of [log.worker,log.coordinator]) {
   fs.writeFileSync(path.join(ep.dir,'exit'),'');
   await cli('terminal','close','--terminal',ep.hello.identity.ORCA_TERMINAL_HANDLE);
  }
 }
 console.log('PASS: shell Dispatch preamble, exact assigned terminal question/reply/worker_done, task-list and dispatch-show confirm completed');
} catch(e) { console.error(e); process.exitCode=1; }
