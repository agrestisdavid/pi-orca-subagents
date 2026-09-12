#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { piCliPath } from './src/pos/resources.mjs';
const source = 'git:github.com/agrestisdavid/pi-orca-subagents@pos-main';
if (process.argv.includes('--help')) {
  console.log('pi-orca-subagents installer\nInstall: node install.mjs\nRemove: node install.mjs --remove\nRequires Pi. Local migration: node migrate-local.mjs');
} else {
  const result = spawnSync(process.execPath, [piCliPath(), process.argv.includes('--remove') ? 'remove' : 'install', source], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
