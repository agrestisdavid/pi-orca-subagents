// Upstream tests intentionally use a fake Pi host. Keep it out of POS's actual
// dependencies: production and POS acceptance tests must load the real SDK.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suite = process.argv[2];
if (!['unit','integration'].includes(suite)) throw Error('Expected unit or integration suite.');
// Windows' default temp directory is below the user's home. Project discovery
// would find their ~/.pi above it. Keep *all* fixture CWDs outside that tree.
const tempBase = process.platform === 'win32' ? path.join(path.parse(root).root, 'Temp') : os.tmpdir();
fs.mkdirSync(tempBase,{recursive:true});
const sandbox = fs.mkdtempSync(path.join(tempBase,'pos-upstream-'));
const fixtureTemp = fs.mkdtempSync(path.join(tempBase,'pos-fixtures-'));
for(const name of ['src','test','tools','skills','agents','prompts','docs','extensions','README.md','index.ts','native.ts','package.json','tsconfig.json','.oxlintrc.json', ...fs.readdirSync(root).filter(n=>n.endsWith('.mjs'))]) {
  fs.cpSync(path.join(root,name),path.join(sandbox,name),{recursive:true});
}
function link(from,to) { fs.mkdirSync(path.dirname(to),{recursive:true}); fs.symlinkSync(from,to,process.platform==='win32'?'junction':'dir'); }
for(const name of fs.readdirSync(path.join(root,'node_modules'))) {
  if(name==='@earendil-works') {
    for(const pkg of fs.readdirSync(path.join(root,'node_modules',name))) {
      const from=pkg==='pi-coding-agent'?path.join(sandbox,'test/fixtures/pi-coding-agent-shim'):path.join(root,'node_modules',name,pkg);
      link(from,path.join(sandbox,'node_modules',name,pkg));
    }
  } else if(fs.statSync(path.join(root,'node_modules',name)).isDirectory()) link(path.join(root,'node_modules',name),path.join(sandbox,'node_modules',name));
}
const loader=suite==='unit'?'isolated-temp-root.mjs':'register-loader.mjs';
const files = process.argv.slice(3);
const child=spawn(process.execPath,['--experimental-strip-types','--import',`./test/support/${loader}`,'--test','--test-concurrency=4','--test-timeout=600000',...(files.length?files:[`test/${suite}/*.test.ts`])],{cwd:sandbox,env:{...process.env,TEMP:fixtureTemp,TMP:fixtureTemp,TMPDIR:fixtureTemp,APPDATA:path.join(fixtureTemp,'appdata')},stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',code=>{
  process.exitCode=code??1;
  // Keep failed evidence available for diagnosis.
  if(code===0) {
    fs.rmSync(sandbox,{recursive:true,force:true});
    fs.rmSync(fixtureTemp,{recursive:true,force:true});
  }
  else console.error('Upstream test sandbox:',sandbox);
});
