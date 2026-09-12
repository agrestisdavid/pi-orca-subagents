#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { agentDirectory, bundledTodoPath } from './src/pos/resources.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const agent = agentDirectory();
const settingsFile = path.join(agent, 'settings.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
if (!fs.existsSync(bundledTodoPath())) throw Error('Install dependencies before migrating.');
if (process.platform === 'win32') {
  const check = spawnSync('powershell.exe', ['-NoProfile','-Command', "@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match '(broker\\.mjs|workflow-host-entry\\.mjs)' } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"], {encoding:'utf8',windowsHide:true});
  if (check.status !== 0) throw Error('Could not inspect active Pi workers; settings were not changed.');
  const processes = JSON.parse(check.stdout.trim() || '[]');
  const active = (Array.isArray(processes) ? processes : [processes]).filter(p => p.CommandLine.replaceAll('\\','/').includes(agent.replaceAll('\\','/')));
  if (active.length) throw Error('Active Pi TUI/workflow hosts must finish before migration: ' + active.map(p=>p.ProcessId).join(', '));
}
const backup = path.join(agent, 'backups', 'pos-migration-' + new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(backup,{recursive:true});
if (fs.existsSync(settingsFile)) fs.copyFileSync(settingsFile,path.join(backup,'settings.json'));
const moved = [];
try {
  for (const relative of ['extensions/pi-bots.ts','skills/pi-bots','skills/subagent-decisions']) {
    const from = path.resolve(agent, relative), to = path.resolve(backup, relative);
    if (!from.startsWith(agent + path.sep) || !to.startsWith(backup + path.sep)) throw Error('Migration path escaped its expected directory.');
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to),{recursive:true});
    fs.renameSync(from,to);moved.push({from,to});
  }
  const isOld = source => typeof source === 'string' && (
    /^npm:pi-subagents(?:@|$)/.test(source) || /(?:^|[\\/])local-packages[\\/]pi-subagents[\\/]?$/.test(source)
    || source === root || /(?:^|[\\/])local-packages[\\/]pi-orca-subagents[\\/]?$/.test(source));
  settings.packages = [...(settings.packages || []).filter(p=>!isOld(typeof p === 'string'?p:p.source)), root];
  if (Array.isArray(settings.extensions)) settings.extensions = settings.extensions.filter(p=>typeof p !== 'string' || !/(?:^|[\\/])pi-bots\.ts$/.test(p));
  if (Array.isArray(settings.skills)) settings.skills = settings.skills.filter(p=>typeof p !== 'string' || !/(?:^|[\\/])(?:pi-bots|subagent-decisions)(?:[\\/]SKILL\.md)?[\\/]?$/.test(p));
  fs.writeFileSync(settingsFile+'.pos.tmp',JSON.stringify(settings,null,2)+'\n');
  fs.renameSync(settingsFile+'.pos.tmp',settingsFile);
  fs.writeFileSync(path.join(backup,'moves.json'),JSON.stringify(moved,null,2)+'\n');
  console.log('POS selected. Reload Pi. Backup: '+backup);
} catch (error) {
  for (const {from,to} of moved.reverse()) if (fs.existsSync(to)) fs.renameSync(to,from);
  if (fs.existsSync(path.join(backup,'settings.json'))) fs.copyFileSync(path.join(backup,'settings.json'),settingsFile);
  throw error;
}
