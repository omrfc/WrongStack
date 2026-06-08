import { describe, expect, it } from 'vitest';
import {
  ALL_AGENT_DEFINITIONS,
  AGENT_CATALOG,
  AGENTS_BY_PHASE,
  getAgentDefinition,
  type AgentPhase,
} from '../../src/coordination/agents/index.js';
import {
  FLEET_ROSTER,
  FLEET_ROSTER_BUDGETS,
  applyRosterBudget,
} from '../../src/coordination/fleet.js';
import { Director } from '../../src/coordination/director.js';
import { makeSpawnTool } from '../../src/coordination/director-tools.js';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

const PHASES: AgentPhase[] = [
  'discovery',
  'planning',
  'build',
  'verify',
  'review',
  'domain',
  'knowledge',
  'delivery',
  'meta',
];

const KEBAB = /^[a-z][a-z0-9-]*$/;
const TOOL_ID = /^[a-z][a-z0-9_-]*$/;

describe('agent catalog integrity', () => {
  it('has 43 catalog definitions and AGENT_CATALOG keys match 1:1', () => {
    expect(ALL_AGENT_DEFINITIONS.length).toBe(43);
    expect(Object.keys(AGENT_CATALOG).length).toBe(43);
    for (const def of ALL_AGENT_DEFINITIONS) {
      expect(AGENT_CATALOG[def.config.role as string]).toBe(def);
    }
  });

  it('every definition is structurally complete and spawnable-shaped', () => {
    for (const def of ALL_AGENT_DEFINITIONS) {
      const { config, budget, capability } = def;
      const role = config.role as string;

      // Identity
      expect(role, `role for ${config.name}`).toMatch(KEBAB);
      expect(config.name?.length ?? 0).toBeGreaterThan(0);
      // Prompts are real role briefs, not stubs.
      expect((config.prompt ?? '').length, `prompt for ${role}`).toBeGreaterThan(50);

      // Tools: non-empty, unique, well-formed ids.
      const tools = config.tools ?? [];
      expect(tools.length, `tools for ${role}`).toBeGreaterThan(0);
      expect(new Set(tools).size, `duplicate tool id in ${role}`).toBe(tools.length);
      for (const t of tools) {
        expect(t, `tool id "${t}" in ${role}`).toMatch(TOOL_ID);
      }

      // Budget tier: at least a positive wall-clock ceiling.
      expect(budget.timeoutMs ?? 0, `budget.timeoutMs for ${role}`).toBeGreaterThan(0);

      // Capability metadata for the dispatcher.
      expect(PHASES, `phase for ${role}`).toContain(capability.phase);
      expect(capability.summary.length, `summary for ${role}`).toBeGreaterThan(0);
      expect(capability.keywords.length, `keywords for ${role}`).toBeGreaterThan(0);
      for (const kw of capability.keywords) {
        expect(kw.length, `empty keyword in ${role}`).toBeGreaterThan(0);
        // Heuristic dispatcher lowercases the task; keywords must be lowercase
        // or they can never match.
        expect(kw, `keyword "${kw}" in ${role} must be lowercase`).toBe(kw.toLowerCase());
      }
    }
  });

  it('groups every catalog agent into exactly one phase and the groups sum to 43', () => {
    let total = 0;
    const seen = new Set<string>();
    for (const phase of PHASES) {
      const group = AGENTS_BY_PHASE[phase];
      expect(Array.isArray(group)).toBe(true);
      for (const def of group) {
        expect(def.capability.phase, `${def.config.role} grouped under wrong phase`).toBe(phase);
        expect(seen.has(def.config.role as string), `${def.config.role} in two phases`).toBe(false);
        seen.add(def.config.role as string);
      }
      total += group.length;
    }
    expect(total).toBe(43);
    expect(seen.size).toBe(43);
  });

  it('getAgentDefinition resolves known roles and rejects unknown ones', () => {
    expect(getAgentDefinition('explore')?.config.role).toBe('explore');
    expect(getAgentDefinition('definitely-not-a-role')).toBeUndefined();
  });
});

describe('fleet roster derivation', () => {
  it('FLEET_ROSTER is the 43 catalog agents + 4 legacy = 47', () => {
    expect(Object.keys(FLEET_ROSTER).length).toBe(47);
    // Legacy four are preserved alongside the catalog.
    for (const legacy of ['audit-log', 'bug-hunter', 'refactor-planner', 'security-scanner']) {
      expect(FLEET_ROSTER[legacy]).toBeDefined();
    }
    // Every catalog role is in the roster.
    for (const def of ALL_AGENT_DEFINITIONS) {
      expect(FLEET_ROSTER[def.config.role as string]).toBeDefined();
    }
  });

  it('every roster role has a budget and applyRosterBudget fills an idle window', () => {
    for (const role of Object.keys(FLEET_ROSTER)) {
      expect(FLEET_ROSTER_BUDGETS[role], `budget for ${role}`).toBeDefined();
      const resolved = applyRosterBudget({ ...FLEET_ROSTER[role]!, role });
      // The default reaper is idle-based now — no wall-clock cap is imposed
      // by default (it killed active agents); idleTimeoutMs is always filled.
      expect(resolved.idleTimeoutMs, `resolved idle window for ${role}`).toBeGreaterThan(0);
      expect(resolved.timeoutMs, `no default wall-clock for ${role}`).toBeUndefined();
    }
  });
});

describe('catalog spawnability (real Director + spawn tool)', () => {
  function makeDirector(): Director {
    const runner = async (
      _task: TaskSpec,
      _ctx: SubagentRunContext,
    ): Promise<SubagentRunOutcome> => ({ iterations: 1, toolCalls: 1 });
    return new Director({
      config: { coordinatorId: 'catalog', doneCondition: { type: 'all_tasks_done' }, maxConcurrent: 4 },
      runner,
    });
  }

  it('spawns every one of the 47 roster roles without error', async () => {
    const director = makeDirector();
    const spawn = makeSpawnTool(director, FLEET_ROSTER);
    const spawnedIds: string[] = [];

    for (const role of Object.keys(FLEET_ROSTER)) {
      const result = (await spawn.execute({ role })) as { subagentId?: string; error?: string };
      expect(result.error, `spawn error for role "${role}"`).toBeUndefined();
      expect(result.subagentId, `no subagentId for role "${role}"`).toBeTruthy();
      spawnedIds.push(result.subagentId!);
    }

    // All 47 produced distinct subagent ids (instantiateRosterConfig must not
    // reuse the template id) and the director registered each one.
    expect(new Set(spawnedIds).size).toBe(47);
    expect(director.status().subagents.length).toBe(47);
  });

  it('reports a clean error for an unknown role instead of throwing', async () => {
    const director = makeDirector();
    const spawn = makeSpawnTool(director, FLEET_ROSTER);
    const result = (await spawn.execute({ role: 'no-such-role' })) as { error?: string };
    expect(result.error).toMatch(/unknown role/i);
  });
});
