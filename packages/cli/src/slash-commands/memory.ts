import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildMemoryCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'memory',
    category: 'Inspect',
    description:
      'Inspect or edit persistent memory: /memory [show|remember <text>|forget <query>|clear]',
    async run(args) {
      const store = opts.memoryStore;
      if (!store) return { message: 'No memory store configured.' };
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();
      switch (verb) {
        case '':
        case 'show':
        case 'list': {
          const text = await store.readAll();
          return {
            message:
              text.trim().length === 0
                ? 'Memory is empty. Add an entry with `/memory remember <text>`.'
                : text,
          };
        }
        case 'remember':
        case 'add': {
          if (!restJoined) return { message: 'Usage: /memory remember <text>' };
          await store.remember(restJoined);
          return { message: `Remembered: ${restJoined}` };
        }
        case 'forget':
        case 'rm': {
          if (!restJoined) return { message: 'Usage: /memory forget <query>' };
          const n = await store.forget(restJoined);
          return {
            message: n === 0 ? `No entries matched "${restJoined}".` : `Forgot ${n} entries.`,
          };
        }
        case 'clear': {
          await store.clear();
          return { message: 'Cleared all memory scopes.' };
        }
        default:
          return {
            message: `Unknown subcommand "${verb}". Try: show | remember <text> | forget <query> | clear`,
          };
      }
    },
  };
}
