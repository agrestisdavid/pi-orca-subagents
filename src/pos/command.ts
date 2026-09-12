import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
const skill = new URL('../../skills/pos/SKILL.md', import.meta.url);

export default function registerPos(pi: ExtensionAPI): void {
  pi.registerCommand('pos', {
    description: 'Delegate with pi-orca-subagents: /pos <task>',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify('POS: /pos <task> — interactive Orca agents by default. Request headless/native explicitly for work without Orca. Skill: /skill:pos. Controls: /subagents, /subagents-fleet, /pi-bots-settings.', 'info');
        return;
      }
      const instructions = fs.readFileSync(skill, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      pi.sendUserMessage(`Skill directory: ${fileURLToPath(new URL('.', skill))}\n\n${instructions}\n\n## User task\n\n${args}`, { deliverAs: 'followUp' });
    },
  });
}
