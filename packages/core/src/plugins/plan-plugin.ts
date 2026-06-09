import {
  addPlanItem,
  clearPlan,
  deriveTodosFromPlanItem,
  emptyPlan,
  formatPlan,
  loadPlan,
  type PlanFile,
  removePlanItem,
  savePlan,
  setPlanItemStatus,
} from '../storage/plan-store.js';
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
    description: 'Strategic plan board: /plan show | add | start | done | promote | template | clear',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as unknown as Record<string, unknown>;
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

export function buildPlanCommand(planPath?: string): SlashCommand {
  return {
    name: 'plan',
    description:
      'Strategic plan board: /plan [show|add <title>|start <id|#>|done <id|#>|remove <id|#>|promote <id|#> [subtask ...]|template [list|use <name>]|clear]',
    async run(args: string, ctx: Context) {
      if (!planPath) return { message: 'Plan storage is not configured for this session.' };
      const sessionId = ctx?.session?.id ?? 'unknown';
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();

      const plan: PlanFile = (await loadPlan(planPath)) ?? emptyPlan(sessionId);

      switch (verb) {
        case '':
        case 'show':
        case 'list':
          return { message: formatPlan(plan) };

        case 'add': {
          if (!restJoined) return { message: 'Usage: /plan add <title>' };
          const { plan: updated, item } = addPlanItem(plan, restJoined);
          await savePlan(planPath, updated);
          return { message: `Added: ${item.title}\n${formatPlan(updated)}` };
        }

        case 'start':
        case 'progress': {
          if (!restJoined) return { message: 'Usage: /plan start <id|index>' };
          const updated = setPlanItemStatus(plan, restJoined, 'in_progress');
          await savePlan(planPath, updated);
          return { message: formatPlan(updated) };
        }

        case 'done':
        case 'complete': {
          if (!restJoined) return { message: 'Usage: /plan done <id|index>' };
          const updated = setPlanItemStatus(plan, restJoined, 'done');
          await savePlan(planPath, updated);
          return { message: formatPlan(updated) };
        }

        case 'remove':
        case 'delete':
        case 'rm': {
          if (!restJoined) return { message: 'Usage: /plan remove <id|index>' };
          const updated = removePlanItem(plan, restJoined);
          await savePlan(planPath, updated);
          return { message: formatPlan(updated) };
        }

        case 'promote': {
          if (!restJoined) return { message: 'Usage: /plan promote <id|index> [subtask ...]' };
          const [target, ...subtasks] = restJoined.split(/\s+/);
          if (!target) return { message: 'Usage: /plan promote <id|index> [subtask ...]' };
          const derived = deriveTodosFromPlanItem(plan, target, subtasks.length > 0 ? subtasks : undefined);
          if (!derived) return { message: `No plan item matched "${target}".` };
          await savePlan(planPath, derived.plan);
          ctx?.state?.replaceTodos(derived.todos);
          return {
            message: `Promoted to ${derived.todos.length} todo(s):\n${formatTodosList(derived.todos)}\n\n${formatPlan(derived.plan)}`,
          };
        }

        case 'template': {
          const subVerb = rest[0] ?? '';
          const subRest = rest.slice(1).join(' ').trim();
          if (subVerb === '' || subVerb === 'list') return { message: formatPlanTemplates() };
          if (subVerb === 'use') {
            if (!subRest) return { message: 'Usage: /plan template use <template-name>' };
            const template = getPlanTemplate(subRest);
            if (!template) {
              return {
                message: `Unknown template "${subRest}". Use /plan template list to see available templates.`,
              };
            }
            let updated = plan;
            for (const item of template.items) {
              ({ plan: updated } = addPlanItem(updated, item.title, item.details));
            }
            await savePlan(planPath, updated);
            return {
              message: `Applied template "${template.name}" (${template.items.length} items):\n${formatPlan(updated)}`,
            };
          }
          return { message: `Unknown template subcommand "${subVerb}". Try: list | use <name>` };
        }

        case 'clear': {
          const updated = clearPlan(plan);
          await savePlan(planPath, updated);
          return { message: 'Plan cleared.' };
        }

        default:
          return {
            message: `Unknown subcommand "${verb}". Try: show | add <title> | start <id|#> | done <id|#> | remove <id|#> | promote <id|#> | template [list|use <name>] | clear`,
          };
      }
    },
  };
}
