import * as path from 'node:path';

/** `wt` is Windows Terminal's app alias on Windows, not a safe discovery probe. */
export function worktrunkCommand(platform: NodeJS.Platform = process.platform, configured = process.env.PI_SUBAGENTS_WORKTRUNK_BIN): string | undefined {
  if (configured?.trim()) {
    const value = configured.trim();
    const paths = platform === 'win32' ? path.win32 : path;
    if (!paths.isAbsolute(value)) throw new Error('PI_SUBAGENTS_WORKTRUNK_BIN must be an absolute path to Worktrunk.');
    if (platform === 'win32' && /[\\/]WindowsApps[\\/]/i.test(value)) throw new Error('PI_SUBAGENTS_WORKTRUNK_BIN must point to Worktrunk, not a Windows app alias.');
    return value;
  }
  return platform === 'win32' ? undefined : 'wt';
}

export const WORKTRUNK_WINDOWS_HINT = 'Worktrunk provider is unavailable: on Windows set PI_SUBAGENTS_WORKTRUNK_BIN to its absolute executable path; wt is reserved for Windows Terminal.';
