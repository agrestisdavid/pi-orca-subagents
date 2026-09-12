import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('local migration preserves settings and backs up only replaced components', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pos-migration-check-'));
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const original={packages:['npm:unrelated','local-packages\\pi-subagents'],subagents:{agentOverrides:{scout:{model:'keep-model'}}},piBots:{stopOnTabClose:false},custom:{keep:true}};
  try {
    fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify(original));
    for(const file of ['extensions/pi-bots.ts','skills/pi-bots/SKILL.md','skills/subagent-decisions/SKILL.md','extensions/keep.ts']) {
      fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),file);
    }
    const result=spawnSync(process.execPath,[path.join(root,'migrate-local.mjs')],{env:{...process.env,PI_CODING_AGENT_DIR:dir},encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    const next=JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8'));
    assert.deepEqual(next,{...original,packages:['npm:unrelated',root]});
    assert(fs.existsSync(path.join(dir,'extensions/keep.ts')));
    assert(!fs.existsSync(path.join(dir,'extensions/pi-bots.ts')));
    const backup=path.join(dir,'backups',fs.readdirSync(path.join(dir,'backups'))[0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup,'settings.json'),'utf8')),original);
    assert.equal(JSON.parse(fs.readFileSync(path.join(backup,'moves.json'),'utf8')).length,3);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
