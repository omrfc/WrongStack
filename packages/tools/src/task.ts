import {
  type TaskItem,
  type TaskStatus,
  type TaskFile,
  computeTaskItemProgress,
  formatTaskList,
} from '@wrongstack/core';
import {
  mutateTasks,
} from '@wrongstack/core';
import {
  addPlanItem,
  emptyPlan,
  loadPlan,
  savePlan,
  formatPlan,
} from '@wrongstack/core';
import { randomUUID } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a task by 1-based index, exact id, or case-insensitive title substring. */
function findTaskIndex(tasks: TaskItem[], query: string): number {
  const asNum = Number.parseInt(query, 10);
  if (!Number.isNaN(asNum)) {
    const idx = asNum - 1;
    if (tasks[idx]) return idx;
  }
  const byId = tasks.findIndex((t) => t.id === query);
  if (byId >= 0) return byId;
  const lower = query.toLowerCase();
  return tasks.findIndex((t) => t.title.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

interface TaskInput {
  /** Replace: set new task list. Add: append a task. Status: update task status. Promote: convert a task to todo items. */
  action: 'replace' | 'add' | 'status' | 'show' | 'promote' | 'planify';
  /** Full task list for action=replace. */
  tasks?: TaskItem[] | undefined;
  /** Single task for action=add. id, createdAt, updatedAt are auto-generated. */
  task?: Omit<TaskItem, 'id' | 'createdAt' | 'updatedAt'> | undefined;
  /** Task id for action=status or target for action=promote. */
  id?: string | undefined;
  /** New status for action=status. */
  status?: TaskStatus | undefined;
  /** Target task (id, 1-based index, or title substring) for action=promote. */
  target?: string | undefined;
  /** Optional subtask titles for action=promote. */
  subtasks?: string[] | undefined;
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
    '- `action: "show"` — view current tasks without changing them\n' +
    '- `action: "promote"` — convert a task into actionable todo items via `target` (id|index|substring)\n' +
    '- `action: "planify"` — promote a task to a plan item (strategic level) via `target` (id|index|substring)\n\n' +
    'Task fields:\n' +
    '- `dependsOn`: list of task IDs this one waits for\n' +
    '- `type`: "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore"\n' +
    '- `priority`: "critical" | "high" | "medium" | "low"\n' +
    '- `assignee`: agent/subagent name (e.g. "bug-hunter", "refactor-planner")\n' +
    '- `estimateHours`: rough time estimate',
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.write'],
  timeoutMs: 2_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['replace', 'add', 'status', 'show', 'promote', 'planify'],
        description: 'replace = set full list, add = append, status = update task status, show = view only, promote = convert task to todos, planify = convert task to plan item.',
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
      id: { type: 'string', description: 'Task id for action=status or target for action=promote.' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed'],
        description: 'New status for action=status.',
      },
      target: {
        type: 'string',
        description: 'Target task identifier (id, 1-based index, or title substring) for action=promote.',
      },
      subtasks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subtask titles for action=promote. Each becomes a pending todo.',
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

    // Early-return result for validation errors that happen before or
    // during the critical section. The lock callback sets this instead of
    // mutating the file, and we return it after the lock releases.
    let early: TaskOutput | null = null;
    // Track promote output for the custom message
    const promoteMeta = { count: 0, title: '' };
    // Track planify data — written to plan file after the task lock releases
    const planifyMeta = { title: '', details: '' };
    let didPlanify = false;
    // collect todos to replace — called AFTER mutateTasks so rollback is possible
    type TodosReplacement = Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string; promotedFromTask?: string }>;
    let todosToReplace: TodosReplacement | null = null;

    const file = await mutateTasks(taskPath, sessionId, async (f: TaskFile) => {
      switch (input.action) {
        case 'show':
          // read-only — no mutation, just return current state
          break;

        case 'replace': {
          if (!Array.isArray(input.tasks)) {
            early = { ok: false, message: 'action=replace requires `tasks` array.', count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          // Validate dependsOn references: must point to IDs within the new batch
          const newIds = new Set(input.tasks.map((t) => t.id));
          for (const t of input.tasks) {
            if (t.dependsOn && t.dependsOn.length > 0) {
              const missing = t.dependsOn.filter((d) => !newIds.has(d));
              if (missing.length > 0) {
                early = {
                  ok: false,
                  message: `dependsOn validation failed: task "${t.id}" references unknown IDs: ${missing.join(', ')}`,
                  count: 0,
                  completed: 0,
                  inProgress: 0,
                };
                return f;
              }
            }
          }
          const now = new Date().toISOString();
          f.tasks = input.tasks.map((t) => ({
            ...t,
            createdAt: t.createdAt || now,
            updatedAt: now,
          }));
          break;
        }

        case 'add': {
          const t = input.task;
          if (!t || !t.title) {
            early = { ok: false, message: 'action=add requires `task` with at least `title`.', count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          // Validate dependsOn: all referenced IDs must exist in the current task list
          if (t.dependsOn && t.dependsOn.length > 0) {
            const existingIds = new Set(f.tasks.map((e: TaskItem) => e.id));
            const missing = t.dependsOn.filter((d) => !existingIds.has(d));
            if (missing.length > 0) {
              early = {
                ok: false,
                message: `dependsOn validation failed: unknown task IDs: ${missing.join(', ')}`,
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
          }
          const now = new Date().toISOString();
          const newTask: TaskItem = {
            id: `task_${Date.now()}_${randomUUID().slice(0, 8)}`,
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
          f.tasks.push(newTask);
          break;
        }

        case 'status': {
          if (!input.id || !input.status) {
            early = { ok: false, message: 'action=status requires `id` and `status`.', count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          const task = f.tasks.find((t: TaskItem) => t.id === input.id);
          if (!task) {
            early = { ok: false, message: `Task "${input.id}" not found.`, count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          task.status = input.status;
          task.updatedAt = new Date().toISOString();
          break;
        }

        case 'promote': {
          const target = input.target?.trim();
          if (!target) {
            early = { ok: false, message: 'action=promote requires `target` (task id, index, or title substring).', count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          const idx = findTaskIndex(f.tasks, target);
          if (idx === -1) {
            early = { ok: false, message: `No task matched "${target}".`, count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          const match = f.tasks[idx];
          /* v8 ignore next 4 -- findTaskIndex returned a valid in-range idx, so match is always defined; defensive. */
          if (!match) {
            early = { ok: false, message: `No task matched "${target}".`, count: 0, completed: 0, inProgress: 0 };
            return f;
          }

          // Mark task in_progress
          if (match.status !== 'completed' && match.status !== 'failed') {
            match.status = 'in_progress';
            match.updatedAt = new Date().toISOString();
          }

          // Build todo items
          const todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string; promotedFromTask?: string }> = [];
          const ts = Date.now();
          todos.push({
            id: `todo_${ts}_task`,
            content: match.title,
            status: 'in_progress',
            activeForm: match.title,
            promotedFromTask: match.id,
          });

          if (match.description) {
            todos.push({
              id: `todo_${ts}_${randomUUID().slice(0, 6)}`,
              content: match.description.slice(0, 200),
              status: 'pending',
              promotedFromTask: match.id,
            });
          }

          if (input.subtasks && input.subtasks.length > 0) {
            for (const st of input.subtasks) {
              todos.push({
                id: `todo_${ts}_${randomUUID().slice(0, 6)}`,
                content: st,
                status: 'pending',
                promotedFromTask: match.id,
              });
            }
          }

          todosToReplace = todos;
          promoteMeta.count = todos.length;
          promoteMeta.title = match.title;
          break;
        }

        case 'planify': {
          const target = input.target?.trim();
          if (!target) {
            early = { ok: false, message: 'action=planify requires `target` (task id, index, or title substring).', count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          const idx = findTaskIndex(f.tasks, target);
          if (idx === -1) {
            early = { ok: false, message: `No task matched "${target}".`, count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          const match = f.tasks[idx];
          /* v8 ignore next 4 -- findTaskIndex returned a valid in-range idx, so match is always defined; defensive. */
          if (!match) {
            early = { ok: false, message: `No task matched "${target}".`, count: 0, completed: 0, inProgress: 0 };
            return f;
          }
          // Extract data — plan write happens after the task lock releases
          planifyMeta.title = match.title;
          planifyMeta.details = match.description ?? '';
          didPlanify = true;
          // Do NOT mutate the task — just copy to plan
          break;
        }

        default:
          early = { ok: false, message: `Unknown action "${(input as { action: string }).action}". Use replace | add | status | show | promote | planify.`, count: 0, completed: 0, inProgress: 0 };
          return f;
      }

      return f;
    });

    // Apply todo replacements after the task file mutation succeeds so that
    // on error the state is rolled back cleanly.
    if (todosToReplace) ctx.state.replaceTodos(todosToReplace);

    // If the callback set an early-return result, use it
    if (early) return early;

    // If planify copied task data, write it to the plan file now
    if (didPlanify) {
      const { title, details } = planifyMeta;
      const planPath = (ctx.meta as Record<string, unknown>)['plan.path'];
      if (typeof planPath === 'string' && planPath) {
        const planCfg = (await loadPlan(planPath)) ?? emptyPlan(sessionId);
        const { plan: updated } = addPlanItem(planCfg, title, details || undefined);
        await savePlan(planPath, updated);
        return {
          ok: true,
          message: `planify ok — added "${title}" to plan.\n${formatPlan(updated)}`,
          count: file.tasks.length,
          completed: computeTaskItemProgress(file.tasks).completed,
          inProgress: computeTaskItemProgress(file.tasks).inProgress,
        };
      }
      return { ok: false, message: 'Plan storage path not configured — cannot planify.', count: 0, completed: 0, inProgress: 0 };
    }

    const p = computeTaskItemProgress(file.tasks);
    const summary = promoteMeta.count > 0
      ? `promote ok — ${promoteMeta.count} todo(s) created from "${promoteMeta.title}".\n${formatTaskList(file.tasks)}`
      : file.tasks.length > 0
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
