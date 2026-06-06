import { randomUUID } from 'node:crypto';
import { type TodoItem, formatTodosList } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/** Find a todo by 1-based index, exact id, or case-insensitive substring. */
function findTodo(
  todos: TodoItem[],
  query: string,
): { idx: number; item: TodoItem } | null {
  const asIndex = Number.parseInt(query, 10);
  if (!Number.isNaN(asIndex)) {
    const idx = asIndex - 1;
    const item = todos[idx];
    if (item) return { idx, item };
  }
  // Try exact id match
  const byId = todos.findIndex((t) => t.id === query);
  if (byId >= 0) return { idx: byId, item: todos[byId] };
  // Fall through to case-insensitive substring
  const q = query.toLowerCase();
  const byContent = todos.findIndex((t) => t.content.toLowerCase().includes(q));
  if (byContent >= 0) return { idx: byContent, item: todos[byContent] };
  return null;
}

export function buildTodosCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'todos',
    category: 'Inspect',
    description:
      'Inspect or edit the live todo list: /todos [show|clear|add|done|remove|rm <id|index>]',
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
          if (n === 0) return { message: 'Todos were already empty.' };
          ctx.state.replaceTodos([]);
          return { message: `Cleared ${n} todo${n === 1 ? '' : 's'}.` };
        }
        case 'add': {
          if (!restJoined) return { message: 'Usage: /todos add <text>' };
          const item: TodoItem = {
            id: `todo_${Date.now()}_${randomUUID().slice(0, 7)}`,
            content: restJoined,
            status: 'pending',
          };
          ctx.state.replaceTodos([...ctx.todos, item]);
          return { message: `Added: ${restJoined}` };
        }
        case 'done':
        case 'complete': {
          if (!restJoined) return { message: 'Usage: /todos done <id|index>' };
          const found = findTodo(ctx.todos, restJoined);
          if (!found) return { message: `No todo matched "${restJoined}".` };
          const doneItem: TodoItem = { ...found.item, status: 'completed' };
          const nextTodos = [
            ...ctx.todos.slice(0, found.idx),
            doneItem,
            ...ctx.todos.slice(found.idx + 1),
          ];
          ctx.state.replaceTodos(nextTodos);
          return { message: `Marked done: ${doneItem.content}` };
        }
        case 'remove':
        case 'rm':
        case 'delete': {
          if (!restJoined) return { message: 'Usage: /todos remove <id|index>' };
          const found = findTodo(ctx.todos, restJoined);
          if (!found) return { message: `No todo matched "${restJoined}".` };
          const nextTodos = [
            ...ctx.todos.slice(0, found.idx),
            ...ctx.todos.slice(found.idx + 1),
          ];
          ctx.state.replaceTodos(nextTodos);
          return { message: `Removed: ${found.item.content}` };
        }
        default:
          return {
            message: `Unknown subcommand "${verb}". Try: show | clear | add <text> | done <id|index> | remove <id|index>`,
          };
      }
    },
  };
}
