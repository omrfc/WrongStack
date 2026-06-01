import { randomUUID } from 'node:crypto';
import type { SubagentConfig, TaskSpec } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { type Director, FleetSpawnBudgetError, FleetCostCapError } from './director.js';
import { dispatchAgent } from './dispatcher.js';
import type { AgentDefinition } from './agents/index.js';
import type { CollabSessionOptions } from './collab-debug.js';

// ---------------------------------------------------------------------------
// Director-facing tool factories.
//
// Each tool's input schema is intentionally minimal — the director model
// reads the descriptions and gets clean structured shapes. We avoid deep
// nested schemas because they confuse smaller models.

export function makeSpawnTool(director: Director, roster?: Record<string, SubagentConfig>): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'Roster role id. When set, the spawn uses the matching config from the roster and ignores other fields.' },
      description: { type: 'string', description: 'Free-form task description. When `role` is not set, the director uses the smart dispatcher to route this to the best-matching catalog agent. Use this when you don\'t know the exact role name.' },
      name: { type: 'string', description: 'Display name for the subagent. Used as a fallback when description-based dispatch does not resolve a role.' },
      provider: { type: 'string', description: 'Provider id (e.g. "anthropic", "openai"). Defaults to the leader provider when omitted.' },
      model: { type: 'string', description: 'Model id within the provider. Defaults to the leader model when omitted.' },
      systemPromptOverride: { type: 'string', description: 'Extra prompt text appended after the role-base prompt.' },
      maxIterations: { type: 'number' },
      maxToolCalls: { type: 'number' },
      maxCostUsd: { type: 'number' },
    },
    required: [],
  };
  return {
    name: 'spawn_subagent',
    description: 'Create a new subagent under this director. Returns the subagent id.',
    usageHint: 'Pass `role` (matches the roster), `description` (smart dispatch to best agent), or `name` + `provider`/`model`. Returns `{ subagentId }`.',
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = (input ?? {}) as Record<string, unknown>;
      const role = typeof i.role === 'string' ? i.role : undefined;
      const description = typeof i.description === 'string' ? i.description : undefined;

      // Resolve base config from roster, explicit role, or dispatch-by-description
      let cfg: SubagentConfig | undefined;

      if (role && roster) {
        const base = roster[role];
        if (!base) return { error: `unknown role "${role}". roster has: ${Object.keys(roster).join(', ')}` };
        cfg = instantiateRosterConfig(role, base);
      } else if (description && !role) {
        // Smart dispatch: route description to best catalog agent using dispatcher
        const dispatchResult = await dispatchAgent(description, {
          classifier: director.dispatchClassifier,
          catalog: roster as unknown as Record<string, AgentDefinition> | undefined,
        });
        const dispatchRole = dispatchResult.role;
        // If we have a matching roster entry for the dispatched role, use it
        if (roster?.[dispatchRole]) {
          cfg = instantiateRosterConfig(dispatchRole, roster[dispatchRole]!);
        } else {
          // Dispatch found a catalog agent but there's no roster entry — use the
          // catalog definition's config as a base template (role name + defaults).
          // We must not mutate the original definition, so spread it.
          const def = dispatchResult.definition;
          cfg = {
            name: def.config.name ?? dispatchRole,
            role: dispatchRole,
            provider: def.config.provider,
            model: def.config.model,
          };
        }
      }

      // Fall back to name-only config when neither role nor description dispatch resolved
      cfg ??= { name: (i.name as string) ?? 'subagent' };

      if (typeof i.name === 'string') cfg.name = i.name;
      if (typeof i.provider === 'string') cfg.provider = i.provider;
      if (typeof i.model === 'string') cfg.model = i.model;
      if (typeof i.systemPromptOverride === 'string') cfg.systemPromptOverride = i.systemPromptOverride;
      if (typeof i.maxIterations === 'number') cfg.maxIterations = i.maxIterations;
      if (typeof i.maxToolCalls === 'number') cfg.maxToolCalls = i.maxToolCalls;
      if (typeof i.maxCostUsd === 'number') cfg.maxCostUsd = i.maxCostUsd;
      try {
        const subagentId = await director.spawn(cfg);
        return { subagentId, provider: cfg.provider, model: cfg.model, name: cfg.name, role: cfg.role };
      } catch (err) {
        if (err instanceof FleetSpawnBudgetError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        if (err instanceof FleetCostCapError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function instantiateRosterConfig(role: string, base: SubagentConfig): SubagentConfig {
  return {
    ...base,
    // Roster entries are templates. A director may spawn several
    // workers with the same role, so never reuse the template id.
    id: `${role}-${randomUUID().slice(0, 8)}`,
  };
}

export function makeAssignTool(director: Director): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      subagentId: { type: 'string', description: 'Target subagent id. Required.' },
      description: { type: 'string', description: 'The task in natural language — what you want this subagent to do.' },
      maxToolCalls: { type: 'number', description: 'Optional per-task tool-call budget override.' },
      timeoutMs: { type: 'number', description: 'Optional per-task timeout in ms.' },
    },
    required: ['subagentId', 'description'],
  };
  return {
    name: 'assign_task',
    description: 'Hand a task to a previously spawned subagent. Returns the task id.',
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = input as { subagentId: string; description: string; maxToolCalls?: number; timeoutMs?: number };
      const task: TaskSpec = { id: randomUUID(), description: i.description, subagentId: i.subagentId, maxToolCalls: i.maxToolCalls, timeoutMs: i.timeoutMs };
      const taskId = await director.assign(task);
      return { taskId, subagentId: i.subagentId };
    },
  };
}

export function makeAwaitTasksTool(director: Director): Tool {
  return {
    name: 'await_tasks',
    description: 'Block until every named task completes. Returns the array of TaskResult.',
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' }, description: 'One or more task ids returned by `assign_task`.' } }, required: ['taskIds'] },
    async execute(input: unknown) {
      const i = input as { taskIds: string[] };
      const results = await director.awaitTasks(i.taskIds);
      return { results };
    },
  };
}

export function makeAskTool(director: Director): Tool {
  return {
    name: 'ask_subagent',
    description: 'Synchronously ask a subagent a question. Blocks until the subagent replies via the bridge.',
    permission: 'auto',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        subagentId: { type: 'string', description: 'Subagent to ask. Must be a previously spawned id.' },
        question: { type: 'string', description: 'The question or instruction.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in ms (default 30s).' },
      },
      required: ['subagentId', 'question'],
    },
    async execute(input: unknown) {
      const i = input as { subagentId: string; question: string; timeoutMs?: number };
      try {
        const answer = await director.ask(i.subagentId, { question: i.question }, i.timeoutMs);
        return { ok: true, answer };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function makeRollUpTool(director: Director): Tool {
  return {
    name: 'roll_up',
    description: "Aggregate completed task results into a single formatted summary.",
    permission: 'auto',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Completed task ids to aggregate.' },
        style: { type: 'string', enum: ['markdown', 'json'], description: 'Output flavor — markdown (default) or json.' },
      },
      required: ['taskIds'],
    },
    async execute(input: unknown) {
      const i = input as { taskIds: string[]; style?: 'markdown' | 'json' };
      const summary = director.rollUp(i.taskIds, i.style ?? 'markdown');
      return { summary, count: i.taskIds.length };
    },
  };
}

export function makeTerminateTool(director: Director): Tool {
  return {
    name: 'terminate_subagent',
    description: 'Forcibly abort a subagent. The subagent finishes its current iteration then exits with status "stopped".',
    permission: 'auto',
    mutating: true,
    inputSchema: { type: 'object', properties: { subagentId: { type: 'string', description: 'Subagent to abort.' } }, required: ['subagentId'] },
    async execute(input: unknown) {
      const i = input as { subagentId: string };
      await director.terminate(i.subagentId);
      return { ok: true };
    },
  };
}

export function makeTerminateAllTool(director: Director): Tool {
  return {
    name: 'terminate_all',
    description:
      'Forcibly stop every subagent in the fleet and drain the pending task queue. ' +
      'In-flight tasks are terminated mid-execution; pending tasks receive ' +
      '"aborted_by_parent" completion immediately. ' +
      'Use this when the fleet is wedged, looping, or you need a clean slate. ' +
      'Compare: work_complete stops spawning but lets running agents finish naturally.',
    permission: 'auto',
    mutating: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      await director.terminateAll();
      return { ok: true, message: `Fleet shutdown complete — all subagents stopped, pending tasks drained.` };
    },
  };
}

export function makeFleetStatusTool(director: Director): Tool {
  return {
    name: 'fleet_status',
    description: "Snapshot of the fleet — every subagent's current status, coordinator counts (total/running/idle/stopped), pending task descriptions, and usage rollup.",
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      const base = director.status();
      const fm = director.fleetManager;
      const stats = fm?.getFleetStats();
      const fleetStatus = fm?.getFleetStatus();
      return {
        subagents: base.subagents,
        coordinatorStats: stats
          ? { total: stats.total, running: stats.running, idle: stats.idle, stopped: stats.stopped }
          : undefined,
        pending: fleetStatus?.pending ?? [],
        usage: fm?.snapshot(),
      };
    },
  };
}

export function makeFleetUsageTool(director: Director): Tool {
  return {
    name: 'fleet_usage',
    description: 'Token + cost breakdown across the fleet, per-subagent and totals.',
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() { return director.snapshot(); },
  };
}

/**
 * Read a subagent's JSONL transcript and return the last assistant text,
 * stop reason, and tool-use count. The director can call this on a
 * running or timed-out subagent to see what it actually produced without
 * having to wait for natural completion.
 */
export function makeFleetSessionTool(director: Director): Tool {
  return {
    name: 'fleet_session',
    description:
      'Read a subagent\'s JSONL transcript and extract its last assistant text, stop reason, and tool-use count. Use this to see what a running or timed-out subagent actually produced.',
    permission: 'auto',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        subagentId: { type: 'string', description: 'Subagent id to read the transcript of.' },
        tail: { type: 'number', description: 'Number of trailing JSONL lines to return. Omit for the full transcript.' },
      },
      required: ['subagentId'],
    },
    async execute(input: unknown) {
      const i = input as { subagentId: string; tail?: number };
      const result = await director.readSession(i.subagentId, i.tail);
      if (!result) {
        return {
          error: `fleet_session: transcript unavailable for "${i.subagentId}". Is sessionsRoot configured?`,
        };
      }
      return result;
    },
  };
}

/**
 * Health snapshot per subagent — budget pressure (how close to limits),
 * last activity timestamp, and current status. Lets the director make
 * smarter routing decisions without having to call fleet_usage + fleet_status separately.
 */
export function makeFleetHealthTool(director: Director): Tool {
  return {
    name: 'fleet_health',
    description:
      'Per-subagent health report: budget pressure (pct of limits consumed), last activity timestamp, and current status. Use to decide whether to assign more work to a subagent or spawn a fresh one.',
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      const status = director.status();
      const snapshot = director.snapshot();
      const subagents = status.subagents ?? [];
      const perSubagent = snapshot.perSubagent ?? {};
      return {
        subagents: subagents.map((s) => {
          const usage = perSubagent[s.id];
          return {
            id: s.id,
            status: s.status,
            lastEventAt: usage?.lastEventAt,
            budgetPressure: {
              iterations: usage?.iterations,
              toolCalls: usage?.toolCalls,
              costUsd: usage?.cost,
            },
          };
        }),
      };
    },
  };
}

/**
 * Collaborative debugging session: BugHunter, RefactorPlanner, and Critic
 * run in parallel on the same target files, with findings flowing through
 * the FleetBus (bug.found → refactor.plan → critic.evaluation).
 *
 * Returns a structured CollabDebugReport containing all bug findings,
 * refactor plans, critic evaluations, and an overall verdict.
 */
export function makeCollabDebugTool(director: Director): Tool {
  return {
    name: 'collab_debug',
    description:
      'Start a collaborative debugging session: BugHunter, RefactorPlanner, and Critic ' +
      'run in parallel on the same target files. BugHunter finds bugs and emits bug.found events. ' +
      'RefactorPlanner listens for bug.found and emits refactor.plan events. ' +
      'Critic evaluates both and emits critic.evaluation events. ' +
      'Returns a structured report with overall verdict (approve / needs_revision / reject).',
    permission: 'auto',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        targetPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths / glob patterns to scan for bugs.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in ms. Default: 600000 (10 minutes).',
        },
      },
      required: ['targetPaths'],
    },
    async execute(input: unknown) {
      const i = input as { targetPaths?: string[]; timeoutMs?: number };
      if (!i.targetPaths?.length) {
        return { error: 'collab_debug: targetPaths is required and must be non-empty.' };
      }
      const options: CollabSessionOptions = {
        targetPaths: i.targetPaths,
        timeoutMs: i.timeoutMs,
      };
      try {
        const report = await director.spawnCollab(options);
        return {
          sessionId: report.sessionId,
          overallVerdict: report.overallVerdict,
          bugCount: report.bugs.length,
          planCount: report.refactorPlans.length,
          evaluationCount: report.evaluations.length,
          summary: report.summary,
          bugs: report.bugs,
          refactorPlans: report.refactorPlans,
          evaluations: report.evaluations,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: 'collab_debug failed: ' + msg };
      }
    },
  };
}

/**
 * Tool for subagents to emit structured events on the FleetBus.
 * Any agent can emit any event type; the Director routes it to all listeners.
 * Common event types in collaborative sessions:
 *   bug.found        — BugHunter emits per-finding
 *   refactor.plan    — RefactorPlanner emits per-plan
 *   critic.evaluation — Critic emits per-evaluation
 *
 * The payload structure is event-type-specific. Use null for empty payloads.
 */
export function makeFleetEmitTool(director: Director): Tool {
  return {
    name: 'fleet_emit',
    description:
      'Emit a structured event on the FleetBus. Any subagent can emit any event type; the Director routes it to all listeners. Use it to stream findings, progress updates, or final results to other agents in real time.',
    permission: 'auto',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Event type string (e.g. bug.found, refactor.plan, critic.evaluation, progress, result).',
        },
        payload: {
          type: 'object',
          description: 'Event payload. Structure depends on event type. Use null if no payload.',
        },
      },
      required: ['type'],
    },
    async execute(input: unknown) {
      const i = input as { type: string; payload?: Record<string, unknown> | null };
      director.fleet.emit({
        subagentId: director.id,
        ts: Date.now(),
        type: i.type,
        payload: i.payload ?? {},
      });
      return { ok: true, event: i.type };
    },
  };
}

/**
 * Signal that the director's work is satisfied and the fleet should wind down.
 *
 * Once called:
 * - `spawn_subagent` throws — no new subagents can be created
 * - `assign_task` synthesizes an immediate `aborted_by_parent` completion
 *   for any queued task (callers awaiting those tasks unblock immediately)
 * - Running subagents are NOT killed — they finish naturally; no new
 *   tasks are dispatched to them
 *
 * Use this when you are satisfied with the results and want the fleet to
 * stop spawning without forcibly stopping in-flight work. Call
 * `terminate_subagent` separately for any subagent you need to stop immediately.
 */
export function makeWorkCompleteTool(director: Director): Tool {
  return {
    name: 'work_complete',
    description:
      "Signal that the director is satisfied with the results and the fleet should wind down. " +
      "After calling this, spawn_subagent will refuse with a budget error and assign_task " +
      "will instantly complete any queued tasks as aborted. Running subagents finish naturally. " +
      "Call terminate_subagent separately to stop specific subagents immediately.",
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      director.workComplete();
      return { ok: true, message: 'Fleet wind-down signaled. No new spawns or task dispatches.' };
    },
  };
}
