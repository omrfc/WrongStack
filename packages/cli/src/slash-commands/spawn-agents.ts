import type { SlashCommand } from '@wrongstack/core';
import { parseSpawnFlags } from '../arg-parser.js';
import type { SlashCommandContext } from './index.js';

export function buildSpawnCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'spawn',
    description: 'Spawn an isolated subagent to handle a task.',
    async run(args) {
      const { description, opts: parsed } = parseSpawnFlags(args.trim());
      if (!description)
        return {
          message:
            'Usage: /spawn [--provider=<id>] [--model=<id>] [--name=<label>] [--tools=a,b,c] <task description>',
        };
      if (!opts.onSpawn) return { message: 'Multi-agent is not enabled in this session.' };
      try {
        const summary =
          Object.keys(parsed).length > 0
            ? await opts.onSpawn(description, parsed)
            : await opts.onSpawn(description);
        return { message: summary };
      } catch (err) {
        return { message: `Spawn failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

export function buildAgentsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'agents',
    description: 'Show status of spawned subagents. With an id, show live monitor view.',
    async run(args) {
      if (!opts.onAgents) return { message: 'Multi-agent is not enabled in this session.' };
      const subagentId = args.trim() || undefined;
      return { message: await opts.onAgents(subagentId) };
    },
  };
}

export function buildDirectorCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'director',
    description:
      'Promote this session to director mode, enabling fleet orchestration tools. Only works before any subagents are spawned.',
    async run() {
      if (!opts.onDirector) return { message: 'Director promotion is not available in this session.' };
      const result = await opts.onDirector();
      if (result === null) {
        return {
          message:
            'Cannot promote to director mode: subagents have already been spawned. Promote before using /spawn, or restart with --director.',
        };
      }
      return { message: result };
    },
  };
}
