import {
  type PlanFile,
  addPlanItem,
  clearPlan,
  deriveTodosFromPlanItem,
  formatPlan,
  getPlanTemplate,
  mutatePlan,
  removePlanItem,
  setPlanItemStatus,
} from '@wrongstack/core';
import {
  type TaskFile,
  emptyTaskFile,
  loadTasks,
  saveTasks,
  formatTaskList,
} from '@wrongstack/core';
import { randomUUID } from 'node:crypto';
import type { Tool } from '@wrongstack/core';

/**
 * `planTool` — the LLM-callable counterpart to the `/plan` slash command.
 *
 * Plans capture strategic, multi-step approaches that survive across
 * session resumes (unlike todos, which are tactical and per-turn).
 * Storage path comes from `ctx.meta['plan.path']` — the CLI seeds this
 * during startup so the tool always knows where to read/write.
 *
 * One tool, multiple actions, JSON in/out. The action discriminates the
 * operation so the LLM can do show / add / start / done / remove / promote /
 * derive / template_use / clear via a single tool registration instead of
 * bloating the surface with nine near-identical tools.
 */
interface PlanInput {
  action:
    | 'show'
    | 'add'
    | 'start'
    | 'done'
    | 'remove'
    | 'promote'
    | 'template_use'
    | 'clear'
    | 'taskify';
  /** Required for add. */
  title?: string | undefined;
  /** Optional detail line for add. */
  details?: string | undefined;
  /** Required for start/done/remove/promote — accepts plan item id OR 1-based index OR title substring. */
  target?: string | undefined;
  /** Optional subtasks for promote. If omitted, a single todo is created from the plan item title. */
  subtasks?: string[] | undefined;
  /** Required for template_use — the template name (e.g. "new-feature", "bug-fix"). */
  template?: string | undefined;
}

interface PlanOutput {
  ok: boolean;
  message: string;
  /** Formatted plan after the operation. Same string the user sees from `/plan show`. */
  plan: string;
  /** Total item count after the operation. */
  count: number;
  /** Number of items not in 'done' status. */
  open: number;
  /** When promote/derive succeed, the generated todo items so the caller can inspect them. */
  todos?: Array<{ id: string; content: string; status: string; activeForm?: string | undefined; promotedFromPlan?: string | undefined }>;
}

export const planTool: Tool<PlanInput, PlanOutput> = {
  name: 'plan',
  category: 'Session',
  description:
    'Manage a persistent strategic plan for the current session. Unlike todos, plans are meant for higher-level, multi-phase approaches and survive across conversation resumptions. ' +
    'Use this to outline big-picture work, then promote concrete items into the todo list when ready to execute.',
  usageHint:
    'RECOMMENDED FOR COMPLEX, MULTI-PHASE WORK:\n\n' +
    '- Start by creating a high-level plan with `action: "add"` or using templates (`template_use`).\n' +
    '- Use `promote` to turn a plan item into actionable todos.\n' +
    '- Use `taskify` to convert a plan item into a structured task (with type/priority/deps).\n' +
    '- Keep plans at the "why and what" level, and todos at the "how and next step" level.\n' +
    '- Common templates: "new-feature", "bug-fix", "refactor", "release", "security-audit".\n\n' +
    'This tool is excellent for maintaining long-term direction across many turns or even multiple sessions.',
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'plan',
  timeoutMs: 2_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'show',
          'add',
          'start',
          'done',
          'remove',
          'promote',
          'template_use',
          'clear',
          'taskify',
        ],
        description: 'The operation to perform on the plan board.',
      },
      title: {
        type: 'string',
        description: 'Title of the plan item. Required for action=add.',
      },
      details: {
        type: 'string',
        description: 'Additional details or description for a new plan item (action=add).',
      },
      target: {
        type: 'string',
        description:
          'Identifier for the target plan item (id, 1-based index, or partial title). Required for most actions except add/show/clear.',
      },
      subtasks: {
        type: 'array',
        items: { type: 'string' },
        description:
          'List of subtask titles. Used with promote to break a plan item into multiple todos.',
      },
      template: {
        type: 'string',
        description:
          'Template identifier when using action=template_use. Common values: new-feature, bug-fix, refactor, release, security-audit.',
      },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const planPath = (ctx.meta as Record<string, unknown>)['plan.path'];
    if (typeof planPath !== 'string' || !planPath) {
      return {
        ok: false,
        message: 'Plan storage path is not configured for this session.',
        plan: '',
        count: 0,
        open: 0,
      };
    }
    const sessionId = ctx.session?.id ?? 'unknown';

    let early: PlanOutput | null = null;
    // Track taskify data — task write happens after the plan lock releases
    const taskifyMeta = { title: '', details: '' };
    let didTaskify = false;

    const plan = await mutatePlan(planPath, sessionId, async (p) => {
      switch (input.action) {
        case 'show':
          break;

        case 'add': {
          const title = input.title?.trim();
          if (!title) {
            early = mkResult(p, false, 'add requires `title`.');
            return p;
          }
          const { plan: updated } = addPlanItem(p, title, input.details?.trim() || undefined);
          return updated;
        }

        case 'start':
        case 'done': {
          if (!input.target) {
            early = mkResult(p, false, `${input.action} requires \`target\` (id|index|substring).`);
            return p;
          }
          const next = setPlanItemStatus(
            p,
            input.target,
            input.action === 'start' ? 'in_progress' : 'done',
          );
          if (next === p) {
            early = mkResult(p, false, `No plan item matched "${input.target}".`);
            return p;
          }
          return next;
        }

        case 'remove': {
          if (!input.target) {
            early = mkResult(p, false, 'remove requires `target` (id|index|substring).');
            return p;
          }
          const next = removePlanItem(p, input.target);
          if (next === p) {
            early = mkResult(p, false, `No plan item matched "${input.target}".`);
            return p;
          }
          return next;
        }

        case 'promote': {
          if (!input.target) {
            early = mkResult(p, false, `${input.action} requires \`target\` (id|index|substring).`);
            return p;
          }
          const derived = deriveTodosFromPlanItem(p, input.target, input.subtasks);
          if (!derived) {
            early = mkResult(p, false, `No plan item matched "${input.target}".`);
            return p;
          }
          ctx.state.replaceTodos(derived.todos);
          early = mkResult(
            derived.plan,
            true,
            `${input.action} ok — ${derived.todos.length} todo(s) created.`,
            derived.todos,
          );
          return derived.plan;
        }

        case 'template_use': {
          const templateName = input.template?.trim();
          if (!templateName) {
            early = mkResult(p, false, 'template_use requires `template` name.');
            return p;
          }
          const template = getPlanTemplate(templateName);
          if (!template) {
            early = mkResult(p, false, `Unknown template "${templateName}".`);
            return p;
          }
          let updated = p;
          for (const item of template.items) {
            ({ plan: updated } = addPlanItem(updated, item.title, item.details));
          }
          early = mkResult(
            updated,
            true,
            `Applied template "${template.name}" — ${template.items.length} items added.`,
          );
          return updated;
        }

        case 'clear':
          return clearPlan(p);

        case 'taskify': {
          if (!input.target) {
            early = mkResult(p, false, 'taskify requires `target` (plan item id|index|substring).');
            return p;
          }
          // Find plan item by 1-based index, exact id, or title substring
          let itemIdx = -1;
          const asNum = Number.parseInt(input.target, 10);
          if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= p.items.length) {
            itemIdx = asNum - 1;
          } else {
            itemIdx = p.items.findIndex((it) => it.id === input.target);
            if (itemIdx === -1) {
              const lower = input.target.toLowerCase();
              itemIdx = p.items.findIndex((it) => it.title.toLowerCase().includes(lower));
            }
          }
          if (itemIdx === -1 || !p.items[itemIdx]) {
            early = mkResult(p, false, `No plan item matched "${input.target}".`);
            return p;
          }
          const item = p.items[itemIdx]!;
          // Extract data — task write happens after the plan lock releases
          taskifyMeta.title = item.title;
          taskifyMeta.details = item.details ?? '';
          didTaskify = true;
          break;
        }

        default:
          early = mkResult(p, false, `Unknown action "${(input as { action: string }).action}".`);
          return p;
      }

      return p;
    });

    // If the callback set an early-return result, use it
    if (early) return early;

    // If taskify copied plan item data, write it to the task file now
    if (didTaskify) {
      const taskPath = (ctx.meta as Record<string, unknown>)['task.path'];
      if (typeof taskPath !== 'string' || !taskPath) {
        return mkResult(plan, false, 'Task storage path not configured — cannot taskify.');
      }
      const taskFile: TaskFile = (await loadTasks(taskPath)) ?? emptyTaskFile(sessionId);
      const now = new Date().toISOString();
      taskFile.tasks.push({
        id: `task_${randomUUID()}`,
        title: taskifyMeta.title,
        description: taskifyMeta.details || undefined,
        type: 'feature',
        priority: 'medium',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
      await saveTasks(taskPath, taskFile);
      return mkResult(
        plan,
        true,
        `taskify ok — added "${taskifyMeta.title}" to tasks.\n${formatTaskList(taskFile.tasks)}`,
      );
    }

    return mkResult(plan, true, `Plan ${input.action} ok.`);
  },
};

function mkResult(
  plan: PlanFile,
  ok: boolean,
  message: string,
  todos?: PlanOutput['todos'],
): PlanOutput {
  const open = plan.items.filter((i) => i.status !== 'done').length;
  const result: PlanOutput = {
    ok,
    message,
    plan: formatPlan(plan),
    count: plan.items.length,
    open,
  };
  if (todos !== undefined) result.todos = todos;
  return result;
}
