import test from 'node:test';
import assert from 'node:assert/strict';
import { worktrunkCommand } from '../../src/runs/shared/worktrunk-command.ts';
import { resolveWorktreeProvider } from '../../src/runs/shared/worktree.ts';
test('Windows never probes the ambiguous wt command automatically', () => {
  assert.equal(worktrunkCommand('win32',''),undefined);
  assert.equal(worktrunkCommand('linux',''),'wt');
  assert.equal(worktrunkCommand('win32','C:\\tools\\worktrunk\\wt.exe'),'C:\\tools\\worktrunk\\wt.exe');
  assert.throws(()=>worktrunkCommand('win32','wt'),/absolute/);
  assert.throws(()=>worktrunkCommand('win32','C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'),/app alias/);
  if(process.platform==='win32' && !process.env.PI_SUBAGENTS_WORKTRUNK_BIN) {
    assert.equal(resolveWorktreeProvider('auto'),'native');
    assert.throws(()=>resolveWorktreeProvider('worktrunk'),/PI_SUBAGENTS_WORKTRUNK_BIN/);
  }
});
