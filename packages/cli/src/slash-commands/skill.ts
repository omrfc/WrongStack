import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildSkillCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'skill',
    description: 'Show skill details or list available skills. Use /skill-gen to create new skills.',
    async run(args) {
      if (!opts.skillLoader) return { message: 'No skill loader configured.' };
      if (!args.trim()) {
        const entries = await opts.skillLoader.listEntries();
        if (entries.length === 0) return { message: 'No skills found.' };
        const lines = entries.map((e) => {
          const scopeTag =
            e.scope.length > 0 ? `  ${color.dim(`(${e.scope.slice(0, 3).join(', ')})`)}` : '';
          return `  ${color.bold(e.name)}${scopeTag}\n    Use when: ${e.trigger}`;
        });
        return { message: `Available skills:\n${lines.join('\n\n')}\n` };
      }
      const skill = await opts.skillLoader.find(args.trim());
      if (!skill) return { message: `Skill "${args.trim()}" not found.` };
      return { message: await opts.skillLoader.readBody(skill.name) };
    },
  };
}
