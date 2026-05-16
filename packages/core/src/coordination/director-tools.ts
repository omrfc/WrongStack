import { randomUUID } from 'node:crypto';
import type { SubagentConfig, TaskSpec } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { type Director, DirectorBudgetError } from './director.js';

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
      role: { type: 'string', description: 'Roster role id (preferred). When set, the spawn uses the matching config from the roster and ignores other fields.' },
      name: { type: 'string', description: 'Display name for the subagent. Required when not using roster.' },
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
    usageHint: 'Either pass `role` (matches the roster) OR pass `name` + optional `provider`/`model`. Returns `{ subagentId }`.',
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = (input ?? {}) as Record<string, unknown>;
      const role = typeof i.role === 'string' ? i.role : undefined;
      const base: SubagentConfig | undefined = role && roster ? roster[role] : undefined;
      if (role && !base) {
        return { error: `unknown role "${role}". roster has: ${roster ? Object.keys(roster).join(', ') : '(empty)'}` };
      }
      const cfg: SubagentConfig = { ...(base ?? { name: (i.name as string) ?? 'subagent' }) };
      if (typeof i.name === 'string') cfg.name = i.name;
      if (typeof i.provider === 'string') cfg.provider = i.provider;
      if (typeof i.model === 'string') cfg.model = i.model;
      if (typeof i.systemPromptOverride === 'string') cfg.systemPromptOverride = i.systemPromptOverride;
      if (typeof i.maxIterations === 'number') cfg.maxIterations = i.maxIterations;
      if (typeof i.maxToolCalls === 'number') cfg.maxToolCalls = i.maxToolCalls;
      if (typeof i.maxCostUsd === 'number') cfg.maxCostUsd = i.maxCostUsd;
      try {
        const subagentId = await director.spawn(cfg);
        return { subagentId, provider: cfg.provider, model: cfg.model, name: cfg.name };
      } catch (err) {
        if (err instanceof DirectorBudgetError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
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
    description: 'Forcibly abort a subagent.',
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

export function makeFleetStatusTool(director: Director): Tool {
  return {
    name: 'fleet_status',
    description: "Snapshot of the fleet — every subagent's current status, pending vs. completed task counts.",
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() { return director.status(); },
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
