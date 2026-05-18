import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * `/skill-gen` — Create a new AI skill interactively.
 *
 * The AI reads the skill-creator skill and guides the user through
 * creating a new SKILL.md file. No wizard needed — the LLM handles
 * the conversation, validation, and file writing.
 *
 * Usage:
 *   /skill-gen              — Start skill creation (AI guides you)
 *   /skill-gen list         — List existing skills
 *   /skill-gen edit <name>  — View an existing skill
 */
export function buildSkillGeneratorCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'skill-gen',
    description: 'Create a new AI skill interactively. The AI will guide you.',
    help: [
      '╔═══ Skill Generator ═══╗',
      '',
      'Create new AI skills with AI guidance.',
      '',
      'Usage:',
      '  /skill-gen              Start skill creation',
      '  /skill-gen list         List existing skills',
      '  /skill-gen edit <name>  View an existing skill',
      '',
      'The AI will ask you questions and create the skill file.',
      'Skills are saved to .wrongstack/skills/<name>/SKILL.md',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim();

      // ── Subcommands ──────────────────────────────────────────────────

      if (trimmed === 'list' || trimmed === 'ls') {
        if (!opts.skillLoader) return { message: 'No skill loader configured.' };
        const entries = await opts.skillLoader.listEntries();
        if (entries.length === 0) return { message: 'No skills found.' };
        const lines = entries.map((e) => {
          const src = e.source === 'project' ? '📁' : e.source === 'user' ? '👤' : '📦';
          return `  ${src} ${e.name}\n     ${e.trigger}`;
        });
        return { message: `Available Skills:\n${lines.join('\n\n')}\n` };
      }

      if (trimmed.startsWith('edit ')) {
        const skillName = trimmed.slice(5).trim();
        if (!opts.skillLoader) return { message: 'No skill loader configured.' };
        const skill = await opts.skillLoader.find(skillName);
        if (!skill) return { message: `Skill "${skillName}" not found.` };
        const body = await opts.skillLoader.readBody(skillName);
        return {
          message: [
            `Skill: ${skillName}`,
            `Path: ${skill.path}`,
            '',
            body,
          ].join('\n'),
        };
      }

      // ── Start AI-guided creation ─────────────────────────────────────
      // Return runText so the AI reads the skill-creator skill and
      // guides the user through creating a new skill.
      return {
        message: '╔═══ Skill Generator ═══╗\n\nThe AI will guide you through creating a new skill.\nAnswer its questions naturally.',
        runText: 'I want to create a new AI skill. Read the skill-creator skill and guide me through the process. Ask me questions one at a time — name, description, what to cover — then create the SKILL.md file.',
      };
    },
  };
}
