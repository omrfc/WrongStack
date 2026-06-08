import {
  type TaskFile,
  type TaskItem,
  type TaskStatus,
  type TaskType,
  type TaskPriority,
  emptyTaskFile,
  formatTaskList,
  formatTaskProgress,
  loadTasks,
  saveTasks,
} from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

function findTask(tasks: TaskItem[], query: string): { idx: number; item: TaskItem } | null {
  const asIndex = Number.parseInt(query, 10);
  if (!Number.isNaN(asIndex)) {
    const idx = asIndex - 1;
    const item = tasks[idx];
    if (item) return { idx, item };
  }
  const byId = tasks.findIndex((t) => t.id === query);
  if (byId >= 0) {
    const item = tasks[byId];
    if (item) return { idx: byId, item };
  }
  const q = query.toLowerCase();
  const byTitle = tasks.findIndex((t) => t.title.toLowerCase().includes(q));
  if (byTitle >= 0) {
    const item = tasks[byTitle];
    if (item) return { idx: byTitle, item };
  }
  return null;
}

function validateType(s: string): TaskType | null {
  const valid: TaskType[] = ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'];
  return valid.includes(s as TaskType) ? (s as TaskType) : null;
}

function validatePriority(s: string): TaskPriority | null {
  const valid: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
  return valid.includes(s as TaskPriority) ? (s as TaskPriority) : null;
}

function validateStatus(s: string): TaskStatus | null {
  const valid: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed'];
  return valid.includes(s as TaskStatus) ? (s as TaskStatus) : null;
}

export function buildTasksCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'tasks',
    category: 'Inspect',
    description:
      'Manage structured tasks with dependencies, types, and priorities: /tasks [show|add <title>|start|done|fail|status <id> <status>|promote <id>|clear]',
    help: [
      'Usage:',
      '  /tasks                            Show task progress + list',
      '  /tasks show                       Same as no args',
      '  /tasks add <title> [type] [prio]  Add a task',
      '  /tasks start <id|index>           Mark task in-progress',
      '  /tasks done <id|index>            Mark task completed',
      '  /tasks fail <id|index>            Mark task failed',
      '  /tasks status <id> <status>       Set exact status (pending|in_progress|blocked|review|completed|failed)',
      '  /tasks depends <id> <depId...>    Set dependencies for a task',
      '  /tasks assign <id> <agent>        Assign task to an agent/subagent',
      '  /tasks promote <id>               Promote task to todo items',
      '  /tasks clear                      Remove all tasks',
      '',
      'Types: feature, bugfix, refactor, docs, test, chore',
      'Priorities: critical, high, medium, low',
    ].join('\n'),
    async run(args, ctx) {
      const taskPath = (ctx.meta as Record<string, unknown>)?.['task.path'];
      if (typeof taskPath !== 'string' || !taskPath) {
        return { message: 'Task storage is not configured for this session.' };
      }
      const sessionId = ctx.session?.id ?? 'unknown';
      const file: TaskFile = (await loadTasks(taskPath)) ?? emptyTaskFile(sessionId);
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();

      switch (verb) {
        case '':
        case 'show':
        case 'list':
          return { message: formatTaskList(file.tasks) };

        case 'progress':
        case 'statusline':
          return { message: formatTaskProgress(file.tasks) };

        case 'add': {
          if (!restJoined) return { message: 'Usage: /tasks add <title> [type] [priority]' };
          const parts = restJoined.split(/\s+/);
          const title = parts[0] ?? '';
          const type = validateType(parts[1] ?? '') ?? 'feature';
          const priority = validatePriority(parts[2] ?? '') ?? 'medium';
          const now = new Date().toISOString();
          const task: TaskItem = {
            id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title,
            type,
            priority,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          };
          file.tasks.push(task);
          await saveTasks(taskPath, file);
          return { message: `Added: ${task.title}\n\n${formatTaskProgress(file.tasks)}` };
        }

        case 'start':
        case 'done':
        case 'fail': {
          if (!restJoined) return { message: `Usage: /tasks ${verb} <id|index>` };
          const found = findTask(file.tasks, restJoined);
          if (!found) return { message: `No task matched "${restJoined}".` };
          const statusMap: Record<string, TaskStatus> = {
            start: 'in_progress',
            done: 'completed',
            fail: 'failed',
          };
          found.item.status = statusMap[verb] ?? 'pending';
          found.item.updatedAt = new Date().toISOString();
          await saveTasks(taskPath, file);
          return { message: `Marked ${verb}: ${found.item.title}\n\n${formatTaskProgress(file.tasks)}` };
        }

        case 'status': {
          if (rest.length < 2) return { message: 'Usage: /tasks status <id> <pending|in_progress|blocked|review|completed|failed>' };
          const targetId = rest[0] ?? '';
          const newStatus = validateStatus(rest[1] ?? '');
          if (!newStatus) return { message: `Invalid status "${rest[1]}". Use: pending, in_progress, blocked, review, completed, failed.` };
          const found = findTask(file.tasks, targetId);
          if (!found) return { message: `No task matched "${targetId}".` };
          found.item.status = newStatus;
          found.item.updatedAt = new Date().toISOString();
          await saveTasks(taskPath, file);
          return { message: `Status → ${newStatus}: ${found.item.title}\n\n${formatTaskProgress(file.tasks)}` };
        }

        case 'depends':
        case 'deps': {
          if (rest.length < 2) return { message: 'Usage: /tasks depends <id> <depId1> [depId2 ...]' };
          const targetId = rest[0] ?? '';
          const depIds = rest.slice(1);
          const found = findTask(file.tasks, targetId);
          if (!found) return { message: `No task matched "${targetId}".` };
          found.item.dependsOn = depIds;
          found.item.updatedAt = new Date().toISOString();
          await saveTasks(taskPath, file);
          return { message: `Dependencies set for "${found.item.title}": ${depIds.join(', ')}` };
        }

        case 'assign': {
          if (rest.length < 2) return { message: 'Usage: /tasks assign <id> <agent>' };
          const targetId = rest[0] ?? '';
          const agent = rest.slice(1).join(' ');
          const found = findTask(file.tasks, targetId);
          if (!found) return { message: `No task matched "${targetId}".` };
          found.item.assignee = agent;
          found.item.updatedAt = new Date().toISOString();
          await saveTasks(taskPath, file);
          return { message: `Assigned to ${agent}: "${found.item.title}"` };
        }

        case 'promote': {
          if (!restJoined) return { message: 'Usage: /tasks promote <id|index>' };
          const found = findTask(file.tasks, restJoined);
          if (!found) return { message: `No task matched "${restJoined}".` };
          found.item.status = 'in_progress';
          found.item.updatedAt = new Date().toISOString();
          // Create a todo from this task
          const todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }> = [
            {
              id: `todo_${Date.now()}_task`,
              content: found.item.title,
              status: 'in_progress' as const,
              activeForm: found.item.title,
            },
          ];
          if (found.item.description) {
            todos.push({
              id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              content: found.item.description.slice(0, 200),
              status: 'pending',
            });
          }
          ctx.state.replaceTodos(todos);
          await saveTasks(taskPath, file);
          return {
            message: `Promoted to ${todos.length} todo(s): "${found.item.title}"\n\n${formatTaskProgress(file.tasks)}`,
          };
        }

        case 'clear': {
          const n = file.tasks.length;
          if (n === 0) return { message: 'Tasks were already empty.' };
          file.tasks = [];
          await saveTasks(taskPath, file);
          return { message: `Cleared ${n} task${n === 1 ? '' : 's'}.` };
        }

        default:
          return {
            message: `Unknown subcommand "${verb}". Try: show | add <title> | start <id> | done <id> | fail <id> | status <id> <s> | depends <id> <deps> | assign <id> <agent> | promote <id> | clear`,
          };
      }
    },
  };
}
