import { randomUUID } from 'node:crypto';
import { formatTodosList } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildTodosCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'todos',
    description:
      'Inspect or edit the live todo list: /todos [show|clear|add <text>|done <id|index>]',
    async run(args) {
      const ctx = opts.context;
      if (!ctx) return { message: 'No active context.' };
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();
      switch (verb) {
        case '':
        case 'show':
        case 'list': {
          return { message: formatTodosList(ctx.todos) };
        }
        case 'clear': {
          const n = ctx.todos.length;
          ctx.todos.length = 0;
          return {
            message:
              n === 0 ? 'Todos were already empty.' : `Cleared ${n} todo${n === 1 ? '' : 's'}.`,
          };
        }
        case 'add': {
          if (!restJoined) return { message: 'Usage: /todos add <text>' };
          ctx.todos.push({
            id: `todo_${Date.now()}_${randomUUID().slice(0, 7)}`,
            content: restJoined,
            status: 'pending',
          });
          return { message: `Added: ${restJoined}` };
        }
        case 'done':
        case 'complete': {
          if (!restJoined) return { message: 'Usage: /todos done <id|index>' };
          const asIndex = Number.parseInt(restJoined, 10);
          let target = !Number.isNaN(asIndex)
            ? ctx.todos[asIndex - 1]
            : ctx.todos.find((t) => t.id === restJoined);
          if (!target)
            target = ctx.todos.find((t) =>
              t.content.toLowerCase().includes(restJoined.toLowerCase()),
            );
          if (!target) return { message: `No todo matched "${restJoined}".` };
          target.status = 'completed';
          return { message: `Marked done: ${target.content}` };
        }
        default:
          return {
            message: `Unknown subcommand "${verb}". Try: show | clear | add <text> | done <id|index>`,
          };
      }
    },
  };
}
