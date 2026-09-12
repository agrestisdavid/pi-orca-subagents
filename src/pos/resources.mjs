import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

export function agentDirectory() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === '~') return home;
  if (configured?.startsWith('~/') || configured?.startsWith('~\\')) return path.join(home, configured.slice(2));
  return path.resolve(configured || path.join(home, '.pi', 'agent'));
}

export function bundledTodoPath() {
  return path.join(path.dirname(require.resolve('@juicesharp/rpiv-todo/package.json')), 'index.ts');
}

export function piCliPath() {
  let dir = path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  while (path.dirname(dir) !== dir) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') return path.join(dir, pkg.bin.pi);
    }
    dir = path.dirname(dir);
  }
  throw new Error('POS requires the Pi coding-agent host.');
}

export function resolveTuiResources() {
  const agentDir = agentDirectory();
  const statusExtension = path.resolve(process.env.POS_ORCA_STATUS_EXTENSION || path.join(agentDir, 'extensions', 'orca-agent-status.ts'));
  if (!fs.existsSync(statusExtension)) {
    throw new Error('POS Orca integration is missing: let Orca install its official Pi hooks, or set POS_ORCA_STATUS_EXTENSION to that hook file. Expected: ' + statusExtension);
  }
  return { agentDir, todoExtension: bundledTodoPath(), statusExtension };
}

/** Prefer our declared Todo dependency over an ambient copy of the same package. */
export function dedupeBundledTodo(base, extensionPaths) {
  const bundled = path.normalize(bundledTodoPath());
  if (!extensionPaths.some(p => path.normalize(p) === bundled)) return base;
  const own = base.extensions.find(e => path.normalize(e.resolvedPath) === bundled);
  if (!own) return base; // Keep load errors visible; never silently substitute another implementation.
  const removed = [];
  const extensions = base.extensions.filter(e => {
    if (e === own || !e.tools.has('todo')) return true;
    const dir = path.dirname(e.resolvedPath);
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== '@juicesharp/rpiv-todo') return true;
      removed.push(e); return false;
    }
    catch { return true; }
  });
  // Pi reports collisions before extensionsOverride, but keeps both extensions.
  // Clear only the now-resolved duplicate Todo diagnostic, never load failures.
  const todoPaths = new Set([own, ...removed].flatMap(e => [e.path, e.resolvedPath]).filter(Boolean));
  const errors = base.errors.filter(error => {
    const prefix = 'Tool "todo" conflicts with ';
    return !(todoPaths.has(error.path) && error.error.startsWith(prefix) && todoPaths.has(error.error.slice(prefix.length)));
  });
  return { ...base, extensions, errors: errors.length === base.errors.length ? base.errors : errors };
}
