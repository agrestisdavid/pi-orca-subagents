import { piCliPath } from '../../../src/pos/resources.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { command, atomicJson } from './orca-adapter.mjs';
const root=path.resolve(process.env.POS_TEST_CWD || "tests/pi-bots-orca");
const config=path.resolve('agent/extensions/subagent/config.json');
const original=fs.existsSync(config)?fs.readFileSync(config):null;
const exe=path.join(process.env.LOCALAPPDATA,'Programs/orca/resources/bin/orca.exe');
const log={originalConfigExisted:original!==null};
try {
 fs.mkdirSync(path.dirname(config),{recursive:true});
 if(original) fs.writeFileSync(path.join(root,'native-config-before.json'),original);
 const value=original?JSON.parse(original.toString()):{};
 value.orcaProgressTabs={...value.orcaProgressTabs,enabled:true};
 atomicJson(config,value);
 log.before=await command(exe,['terminal','list','--worktree',`path:${root}`,'--json']);
 const child=spawn(process.execPath,[piCliPath(),'--mode','rpc','--no-extensions','-e',path.resolve('native.ts'),'-e',fileURLToPath(new URL('./native-smoke-extension.ts', import.meta.url)),'--no-skills','--no-context-files','--offline','--session-dir',path.join(root,'sessions')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const output=fs.createWriteStream(path.join(root,'native-host.log'));
 child.stdout.pipe(output);child.stderr.pipe(output);
 log.exitCode=await new Promise(r=>child.on('exit',r));
 log.after=await command(exe,['terminal','list','--worktree',`path:${root}`,'--json']);
} finally {
 if(original===null) fs.unlinkSync(config); else fs.writeFileSync(config,original);
 log.restored=original===null?!fs.existsSync(config):fs.readFileSync(config).equals(original);
 atomicJson(path.join(root,'native-progress-test.json'),log);
 console.log(JSON.stringify({exitCode:log.exitCode,configRestored:log.restored}));
}
