import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core';
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

      // Check BEFORE writing — was this file missing?
      const isFirstInit = !(await fileExists(file));

      const detected = await detectProjectFacts(ctx.projectRoot);
      const body = renderAgentsTemplate(detected);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, body, 'utf8');

      // Detect Node.js project for tech stack scan suggestion
      let nodePkg = false;
      try {
        await fs.access(path.join(ctx.projectRoot, 'package.json'));
        nodePkg = true;
      } catch {
        // Not a Node.js project — skip techstack suggestion.
      }

      const lines: string[] = [];
      lines.push(`Wrote ${file}`);

      if (detected.hints.length > 0) {
        opts.renderer.writeInfo(`Wrote ${file}`);
        const hintLine = `Pre-filled: ${detected.hints.join(', ')}. Edit the file with project context and instructions the system prompt should carry.`;
        opts.renderer.writeInfo(hintLine);
        lines.push(hintLine);
      } else {
        opts.renderer.writeInfo(`Wrote ${file}`);
        lines.push('No project type auto-detected. Edit the file with project context and instructions the system prompt should carry.');
      }

      // On first init of a Node.js project, suggest (or auto-run) tech stack scan
      if (nodePkg && isFirstInit) {
        const techHint = [
          '',
          `${color.cyan('💡')} ${color.bold('Tech Stack Audit')} — This is a Node.js project with a fresh init.`,
          color.dim('  The LLM may have suggested stale version numbers. Run'),
          `  ${color.cyan('/techstack --init')}  to scan dependencies and verify versions.`,
        ].join('\n');
        opts.renderer.write(techHint);
        lines.push(techHint);
      }

      return { message: lines.join('\n') };
    },
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
