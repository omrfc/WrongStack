import {
  type TaskItem,
  type TaskStatus,
  computeTaskItemProgress,
  formatTaskList,
} from '@wrongstack/core';
import {
  type TaskFile,
  emptyTaskFile,
  loadTasks,
  saveTasks,
} from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Task tool — structured work items with dependencies, types, and priorities.
// Unlike `todo` (flat, session-scoped), tasks support:
//   - Dependencies (task can depend on other tasks)
//   - Type classification (feature, bugfix, refactor, docs, test, chore)
//   - Priority ranking (critical, high, medium, low)
//   - Assignment (which agent/subagent)
//   - Estimates (hours)
//
// Like `todo`, the list is fully replaced on every call. Stored per-session
// at `ctx.meta['task.path']`.
// ---------------------------------------------------------------------------

interface TaskInput {
  /** Replace: set new task list. Add: append a task. Status: update task status. */
  action: 'replace' | 'add' | 'status' | 'show';
  /** Full task list for action=replace. */
  tasks?: TaskItem[] | undefined;
  /** Single task for action=add. id, createdAt, updatedAt are auto-generated. */
  task?: Omit<TaskItem, 'id' | 'createdAt' | 'updatedAt'> | undefined;
  /** Task id for action=status. */
  id?: string | undefined;
  /** New status for action=status. */
  status?: TaskStatus | undefined;
}

interface TaskOutput {
  ok: boolean;
  message: string;
  count: number;
  completed: number;
  inProgress: number;
}

export const taskTool: Tool<TaskInput, TaskOutput> = {
  name: 'task',
  category: 'Session',
  description:
    'Manage structured work items with dependencies, types, and priorities. ' +
    'Use this for complex, multi-step work where tasks have ordering constraints. ' +
    'Unlike `todo` (flat, tactical), `task` supports typed work (feature/bugfix/refactor/etc.), ' +
    'dependencies between items, priority ranking, and agent assignment. ' +
    'The task list persists across session resumes.',
  usageHint:
    'USE FOR STRUCTURED WORK:\n' +
    '- `action: "replace"` — set the complete task list (tasks ordered by priority)\n' +
    '- `action: "add"` — append a single task\n' +
    '- `action: "status"` — update a task\'s status (e.g. pending→in_progress, in_progress→completed)\n' +
    '- `action: "show"` — view current tasks without changing them\n\n' +
    'Task fields:\n' +
    '- `dependsOn`: list of task IDs this one waits for\n' +
    '- `type`: "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore"\n' +
    '- `priority`: "critical" | "high" | "medium" | "low"\n' +
    '- `assignee`: agent/subagent name (e.g. "bug-hunter", "refactor-planner")\n' +
    '- `estimateHours`: rough time estimate',
  permission: 'auto',
  mutating: false,
  timeoutMs: 2_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['replace', 'add', 'status', 'show'],
        description: 'replace = set full list, add = append, status = update task status, show = view only.',
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique id (e.g. "t1", "auth-flow").' },
            title: { type: 'string', description: 'Short title.' },
            description: { type: 'string', description: 'Optional details.' },
            type: { type: 'string', enum: ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'] },
            priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed'] },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of tasks this one depends on.',
            },
            assignee: { type: 'string', description: 'Agent/subagent assigned.' },
            estimateHours: { type: 'number', description: 'Estimated hours.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
          required: ['id', 'title', 'type', 'priority', 'status'],
        },
        description: 'Complete task list. Replaces previous list entirely.',
      },
      task: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'] },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed'] },
          dependsOn: { type: 'array', items: { type: 'string' } },
          assignee: { type: 'string' },
          estimateHours: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'type', 'priority'],
        description: 'Single task to append (id/createdAt/updatedAt auto-generated).',
      },
      id: { type: 'string', description: 'Task id for action=status.' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed'],
        description: 'New status for action=status.',
      },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const taskPath = (ctx.meta as Record<string, unknown>)['task.path'];
    if (typeof taskPath !== 'string' || !taskPath) {
      return { ok: false, message: 'Task storage path not configured.', count: 0, completed: 0, inProgress: 0 };
    }
    const sessionId = ctx.session?.id ?? 'unknown';
    let file: TaskFile = (await loadTasks(taskPath)) ?? emptyTaskFile(sessionId);

    switch (input.action) {
      case 'show':
        break;

      case 'replace': {
        if (!Array.isArray(input.tasks)) {
          return { ok: false, message: 'action=replace requires `tasks` array.', count: 0, completed: 0, inProgress: 0 };
        }
        const now = new Date().toISOString();
        file.tasks = input.tasks.map((t) => ({
          ...t,
          createdAt: t.createdAt || now,
          updatedAt: now,
        }));
        await saveTasks(taskPath, file);
        break;
      }

      case 'add': {
        const t = input.task;
        if (!t || !t.title) {
          return { ok: false, message: 'action=add requires `task` with at least `title`.', count: 0, completed: 0, inProgress: 0 };
        }
        const now = new Date().toISOString();
        const newTask: TaskItem = {
          id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          title: t.title,
          description: t.description,
          type: t.type || 'feature',
          priority: t.priority || 'medium',
          status: t.status || 'pending',
          dependsOn: t.dependsOn,
          assignee: t.assignee,
          estimateHours: t.estimateHours,
          tags: t.tags,
          createdAt: now,
          updatedAt: now,
        };
        file.tasks.push(newTask);
        await saveTasks(taskPath, file);
        break;
      }

      case 'status': {
        if (!input.id || !input.status) {
          return { ok: false, message: 'action=status requires `id` and `status`.', count: 0, completed: 0, inProgress: 0 };
        }
        const task = file.tasks.find((t) => t.id === input.id);
        if (!task) {
          return { ok: false, message: `Task "${input.id}" not found.`, count: 0, completed: 0, inProgress: 0 };
        }
        task.status = input.status;
        task.updatedAt = new Date().toISOString();
        await saveTasks(taskPath, file);
        break;
      }

      default:
        return { ok: false, message: `Unknown action "${(input as { action: string }).action}". Use replace | add | status | show.`, count: 0, completed: 0, inProgress: 0 };
    }

    const p = computeTaskItemProgress(file.tasks);
    const summary = file.tasks.length > 0
      ? formatTaskList(file.tasks)
      : 'No tasks.';
    return {
      ok: true,
      message: summary,
      count: file.tasks.length,
      completed: p.completed,
      inProgress: p.inProgress,
    };
  },
};
