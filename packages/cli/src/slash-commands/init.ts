import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core';
import { detectProjectFacts, renderAgentsTemplate } from './helpers.js';
import type { SlashCommandContext } from './index.js';

export function buildInitCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'init',
    category: 'Config',
    description: 'Create or update .wrongstack/AGENTS.md project context for the system prompt.',
    async run(_args, ctx) {
      const dir = path.join(ctx.projectRoot, '.wrongstack');
      const file = path.join(dir, 'AGENTS.md');
      const detected = await detectProjectFacts(ctx.projectRoot);
      const body = renderAgentsTemplate(detected);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, body, 'utf8');
      if (detected.hints.length > 0) {
        const msg = `Wrote ${file}\nPre-filled: ${detected.hints.join(', ')}. Edit the file with project context and instructions the system prompt should carry.`;
        opts.renderer.writeInfo(`Wrote ${file}`);
        opts.renderer.writeInfo(
          `Pre-filled: ${detected.hints.join(', ')}. Edit the file with project context and instructions the system prompt should carry.`,
        );
        return { message: msg };
      }
      const msg = `Wrote ${file}\nNo project type auto-detected. Edit the file with project context and instructions the system prompt should carry.`;
      opts.renderer.writeInfo(`Wrote ${file}`);
      return { message: msg };
    },
  };
}
