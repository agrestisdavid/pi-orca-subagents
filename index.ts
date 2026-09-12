import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type {} from "./src/types/pi-runtime-compat.d.ts";
import native from './native.ts';
import bots from './extensions/pi-bots.ts';
import pos from './src/pos/command.ts';
export default function register(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  native(pi);
  bots(pi);
  pos(pi);
}
