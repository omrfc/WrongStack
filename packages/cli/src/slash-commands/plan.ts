import {
  addPlanItem,
  clearPlan,
  deriveTodosFromPlanItem,
  emptyPlan,
  formatPlan,
  formatPlanTemplates,
  formatTodosList,
  getPlanTemplate,
  loadPlan,
  type PlanFile,
  removePlanItem,
  savePlan,
  setPlanItemStatus,
} from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * `/plan` — strategic counterpart to `/todos`.
 *
 * Plans are higher-level than todos: a plan captures the overall approach
 * before any work begins, surviving session resume by default. Todos are
 * the moment-to-moment task board the LLM mutates per-turn.
 *
 * Storage: `<session-dir>/<session-id>.plan.json` — atomic-written on
 * every mutation, read on session resume so a banner can surface
 * "you have N open plan items".
 */
export function buildPlanCommand(opts: SlashCommandContext & { planPath?: string }): SlashCommand {
  return {
    name: 'plan',
    description:
      'Strategic plan board: /plan [show|add <title>|start <id|#>|done <id|#>|remove <id|#>|promote <id|#> [subtask ...]|derive <id|#>|template [list|use <name>]|clear]',
    async run(args) {
      const planPath = opts.planPath;
      if (!planPath) return { message: 'Plan storage is not configured for this session.' };
      const ctx = opts.context;
      const sessionId = ctx?.session.id ?? 'unknown';
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();

      const plan: PlanFile = (await loadPlan(planPath)) ?? emptyPlan(sessionId);

      switch (verb) {
        case '':
        case 'show':
        case 'list': {
          return { message: formatPlan(plan) };
        }
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
          if (ctx) {
            ctx.state.replaceTodos(derived.todos);
          }
          return {
            message: `Promoted to ${derived.todos.length} todo(s):\n${formatTodosList(derived.todos)}\n\n${formatPlan(derived.plan)}`,
          };
        }
        case 'derive': {
          if (!restJoined) return { message: 'Usage: /plan derive <id|index>' };
          const derived = deriveTodosFromPlanItem(plan, restJoined);
          if (!derived) return { message: `No plan item matched "${restJoined}".` };
          await savePlan(planPath, derived.plan);
          if (ctx) {
            ctx.state.replaceTodos(derived.todos);
          }
          return {
            message: `Derived ${derived.todos.length} todo(s):\n${formatTodosList(derived.todos)}\n\n${formatPlan(derived.plan)}`,
          };
        }
        case 'template': {
          const subVerb = rest[0] ?? '';
          const subRest = rest.slice(1).join(' ').trim();
          if (subVerb === '' || subVerb === 'list') {
            return { message: formatPlanTemplates() };
          }
          if (subVerb === 'use') {
            if (!subRest) return { message: 'Usage: /plan template use <template-name>' };
            const template = getPlanTemplate(subRest);
            if (!template) return { message: `Unknown template "${subRest}". Use /plan template list to see available templates.` };
            let updated = plan;
            for (const item of template.items) {
              ({ plan: updated } = addPlanItem(updated, item.title, item.details));
            }
            await savePlan(planPath, updated);
            return { message: `Applied template "${template.name}" (${template.items.length} items):\n${formatPlan(updated)}` };
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
            message: `Unknown subcommand "${verb}". Try: show | add <title> | start <id|#> | done <id|#> | remove <id|#> | promote <id|#> | derive <id|#> | template [list|use <name>] | clear`,
          };
      }
    },
  };
}
