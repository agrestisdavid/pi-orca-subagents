// The invoking Pi terminal already is the coordinator. Its adapter runs in the
// background; creating another visible coordinator would double every launch.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson, command, ensureBoundAdapter} from './orca-adapter.mjs';

export function parentTerminal(env, terminals) {
  const keys = ['ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_TAB_ID'];
  if (!keys.some(key => env[key])) return undefined;
  if (!keys.every(key => env[key])) throw Error('The parent Orca terminal identity is incomplete. No coordinator tab was created.');
  const matches = terminals.map(t => ({...t, paneKey: t.paneKey || (t.tabId && t.leafId ? `${t.tabId}:${t.leafId}` : undefined)}))
    .filter(t => t.handle === env.ORCA_TERMINAL_HANDLE && t.paneKey === env.ORCA_PANE_KEY && t.tabId === env.ORCA_TAB_ID);
  if (matches.length !== 1 || !matches[0].connected || matches[0].orphaned)
    throw Error('The original parent Orca terminal is unavailable or ambiguous. No replacement coordinator was created.');
  return matches[0];
}

export async function bindParentCoordinator(root, exe, env = process.env, io = {command, ensureBoundAdapter}) {
  const dir = path.join(root, 'coordinator');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8')); } catch {}
  if (!['ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_TAB_ID'].some(key => env[key])) {
    if (previous?.ownedTerminal === false) throw Error('The original parent binding is missing; no replacement coordinator was created.');
    return undefined;
  }
  const listed = await io.command(exe, ['terminal', 'list', '--json']);
  if (!listed.ok || listed.data?.ok === false || !Array.isArray(listed.data?.result?.terminals))
    throw Error('Orca could not verify the parent terminal; no coordinator tab was created.');
  const terminal = parentTerminal(env, listed.data.result.terminals);
  if (previous && (previous.terminal.paneKey !== terminal.paneKey || previous.terminal.tabId !== terminal.tabId))
    throw Error('The original coordinator belongs to another parent terminal; replacement blocked.');
  fs.mkdirSync(dir, {recursive: true});
  const identity = Object.fromEntries(['ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_WORKTREE_ID'].map(key => [key, env[key] || null]));
  const binding = {id: randomUUID(), identity, env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('ORCA_')))};
  // Persist borrowed ownership before starting anything so cleanup/recovery can
  // never type into, close, or replace the user's parent terminal.
  const endpoint = {dir, terminal, identity, ownedTerminal: false};
  atomicJson(path.join(dir, 'endpoint.json'), endpoint);
  atomicJson(path.join(dir, 'terminal.json'), terminal);
  atomicJson(path.join(dir, 'binding.json'), binding);
  io.ensureBoundAdapter(dir, exe);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    let hello;
    try { hello = JSON.parse(fs.readFileSync(path.join(dir, 'hello.json'), 'utf8')); } catch {}
    if (hello?.bindingId === binding.id && hello.identity?.ORCA_TERMINAL_HANDLE === terminal.handle) return endpoint;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('The background coordinator did not acknowledge the parent binding; no duplicate was started.');
}
