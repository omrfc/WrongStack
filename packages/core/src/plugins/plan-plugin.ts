import {
  addPlanItem,
  clearPlan,
  deriveTodosFromPlanItem,
  emptyPlan,
  formatPlan,
  loadPlan,
  mutatePlan,
  type PlanFile,
  removePlanItem,
  setPlanItemStatus,
} from '../storage/plan-store.js';
import {
  type TaskFile,
  emptyTaskFile,
  loadTasks,
  saveTasks,
} from '../storage/task-store.js';
import { formatTaskList } from '../utils/task-format.js';
import { formatPlanTemplates, getPlanTemplate } from '../storage/plan-templates.js';
import { formatTodosList } from '../utils/todos-format.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand, Context } from '../index.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

interface PlanPluginOptions {
  paths?: WstackPaths | undefined;
}

/**
 * PlanPlugin — strategic plan board (`/plan`), the higher-level counterpart to
 * `/todos`. First-party ("official") plugin, so the command keeps its bare
 * name. Plans persist to `<projectDir>/plan.json` (from the injected
 * `WstackPaths`); the live context is read off `ctx` at dispatch.
 */
export function createPlanPlugin(opts?: PlanPluginOptions): Plugin {
  return {
    name: 'wstack-plan',
    version: '1.0.0',
    description: 'Strategic plan board: /plan show | add | start | done | promote | taskify | template | clear',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as never as Record<string, unknown>;
      const paths = opts?.paths ?? (rawConfig.paths as WstackPaths | undefined);
      api.slashCommands.register(buildPlanCommand(paths?.projectPlan));
      api.log.info('[plan] loaded — /plan available');
    },

    teardown(api) {
      api.slashCommands.unregister('plan');
      api.log.info('[plan] unloaded');
    },

    async health() {
      return { ok: true, message: 'plan board ready' };
    },
  };
}

/** Find a plan item by 1-based index, exact id, or case-insensitive title substring. */
function findPlanItemIndex(plan: PlanFile, query: string): number {
  const asNum = Number.parseInt(query, 10);
  if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= plan.items.length) return asNum - 1;
  const byId = plan.items.findIndex((it) => it.id === query);
  if (byId >= 0) return byId;
  const lower = query.toLowerCase();
  return plan.items.findIndex((it) => it.title.toLowerCase().includes(lower));
}

export function buildPlanCommand(planPath?: string): SlashCommand {
  return {
    name: 'plan',
    description:
      'Strategic plan board: /plan [show|add <title>|start <id|#>|done <id|#>|remove <id|#>|promote <id|#> [subtask ...]|derive <id|#> [subtask ...]|taskify <id|#>|template [list|use <name>]|clear]',
    async run(args: string, ctx: Context) {
      if (!planPath) return { message: 'Plan storage is not configured for this session.' };
      const sessionId = ctx?.session?.id ?? 'unknown';
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();

      // Read-only — no lock
      if (verb === '' || verb === 'show' || verb === 'list') {
        const plan = await loadPlan(planPath);
        return { message: formatPlan(plan ?? emptyPlan(sessionId)) };
      }

      // taskify: reads plan, writes task — handled outside plan lock
      if (verb === 'taskify') {
        if (!restJoined) return { message: 'Usage: /plan taskify <id|index>' };
        const plan = (await loadPlan(planPath)) ?? emptyPlan(sessionId);
        const itemIdx = findPlanItemIndex(plan, restJoined);
        if (itemIdx === -1 || !plan.items[itemIdx]) return { message: `No plan item matched "${restJoined}".` };
        const item = plan.items[itemIdx]!;

        const taskPath = (ctx?.meta as Record<string, unknown>)?.['task.path'];
        if (typeof taskPath !== 'string' || !taskPath) return { message: 'Task storage is not configured for this session.' };

        const taskFile: TaskFile = (await loadTasks(taskPath)) ?? emptyTaskFile(sessionId);
        const now = new Date().toISOString();
        taskFile.tasks.push({
          id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          title: item.title, description: item.details,
          type: 'feature', priority: 'medium', status: 'pending',
          createdAt: now, updatedAt: now,
        });
        await saveTasks(taskPath, taskFile);
        return { message: `Taskified "${item.title}" → task.\n${formatTaskList(taskFile.tasks)}` };
      }

      // Mutating ops — locked via mutatePlan
      let outputMessage = '';
      await mutatePlan(planPath, sessionId, async (plan) => {
        switch (verb) {
          case 'add': {
            if (!restJoined) { outputMessage = 'Usage: /plan add <title>'; return plan; }
            const { plan: updated, item } = addPlanItem(plan, restJoined);
            outputMessage = `Added: ${item.title}\n${formatPlan(updated)}`;
            return updated;
          }
          case 'start':
          case 'progress': {
            if (!restJoined) { outputMessage = 'Usage: /plan start <id|index>'; return plan; }
            const updated = setPlanItemStatus(plan, restJoined, 'in_progress');
            outputMessage = formatPlan(updated);
            return updated;
          }
          case 'done':
          case 'complete': {
            if (!restJoined) { outputMessage = 'Usage: /plan done <id|index>'; return plan; }
            const updated = setPlanItemStatus(plan, restJoined, 'done');
            outputMessage = formatPlan(updated);
            return updated;
          }
          case 'remove':
          case 'delete':
          case 'rm': {
            if (!restJoined) { outputMessage = 'Usage: /plan remove <id|index>'; return plan; }
            const updated = removePlanItem(plan, restJoined);
            outputMessage = formatPlan(updated);
            return updated;
          }
          case 'promote':
          case 'derive': {
            if (!restJoined) { outputMessage = `Usage: /plan ${verb} <id|index> [subtask ...]`; return plan; }
            const [target, ...subtasks] = restJoined.split(/\s+/);
            if (!target) { outputMessage = `Usage: /plan ${verb} <id|index> [subtask ...]`; return plan; }
            const derived = deriveTodosFromPlanItem(plan, target, subtasks.length > 0 ? subtasks : undefined);
            if (!derived) { outputMessage = `No plan item matched "${target}".`; return plan; }
            ctx?.state?.replaceTodos(derived.todos);
            const label = verb === 'derive' ? 'Derived' : 'Promoted to';
            outputMessage = `${label} ${derived.todos.length} todo(s):\n${formatTodosList(derived.todos)}\n\n${formatPlan(derived.plan)}`;
            return derived.plan;
          }
          case 'template': {
            const subVerb = rest[0] ?? '';
            const subRest = rest.slice(1).join(' ').trim();
            if (subVerb === '' || subVerb === 'list') {
              outputMessage = formatPlanTemplates();
              return plan;
            }
            if (subVerb === 'use') {
              if (!subRest) { outputMessage = 'Usage: /plan template use <template-name>'; return plan; }
              const template = getPlanTemplate(subRest);
              if (!template) { outputMessage = `Unknown template "${subRest}".`; return plan; }
              let updated = plan;
              for (const item of template.items) {
                ({ plan: updated } = addPlanItem(updated, item.title, item.details));
              }
              outputMessage = `Applied template "${template.name}" (${template.items.length} items):\n${formatPlan(updated)}`;
              return updated;
            }
            outputMessage = `Unknown template subcommand "${subVerb}". Try: list | use <name>`;
            return plan;
          }
          case 'clear': {
            const updated = clearPlan(plan);
            outputMessage = 'Plan cleared.';
            return updated;
          }
          default:
            outputMessage = `Unknown subcommand "${verb}". Try: show | add <title> | start <id|#> | done <id|#> | remove <id|#> | promote <id|#> | taskify <id|#> | template [list|use <name>] | clear`;
            return plan;
        }
      });

      return { message: outputMessage };
    },
  };
}
