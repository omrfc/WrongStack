/**
 * Pre-built subagent role configurations for the WrongStack fleet.
 * These can be passed to `MultiAgentHost.spawn()` or used as templates
 * for the director's roster.
 */
import type { SubagentConfig } from '../types/multi-agent.js';
import { ALL_AGENT_DEFINITIONS } from './agents/index.js';
import { agentPrompt } from './agents/agent-prompts.js';

/**
 * Audit Log Agent — analyzes session logs, event streams, and traces.
 * Use for: post-mortems, trend analysis, operational insights.
 */
export const AUDIT_LOG_AGENT: SubagentConfig = {
  id: 'audit-log',
  name: 'Audit Log',
  role: 'audit-log',
  prompt: agentPrompt('audit-log'),

  // No hardcoded budgets — the orchestrator (delegate tool or
  // spawn_subagent) decides per-task how much room a subagent gets.
  // A monorepo audit needs hours; a single-file lint check needs
  // seconds. Pinning a number here forces the orchestrator to fight
  // the role's default instead of just asking for what it needs.
};

/**
 * Bug Hunter Agent — systematic bug and code smell detection.
 * Use for: pre-refactoring health checks, code review, regression prevention.
 */
export const BUG_HUNTER_AGENT: SubagentConfig = {
  id: 'bug-hunter',
  name: 'Bug Hunter',
  role: 'bug-hunter',
  prompt: agentPrompt('bug-hunter'),

  // Budgets are set by the orchestrator per task — see fleet.ts header.
};

/**
 * Refactor Planner Agent — structured refactoring planning.
 * Use for: large rewrites, technical debt reduction, architecture improvements.
 */
export const REFACTOR_PLANNER_AGENT: SubagentConfig = {
  id: 'refactor-planner',
  name: 'Refactor Planner',
  role: 'refactor-planner',
  prompt: agentPrompt('refactor-planner'),

  // Budgets are set by the orchestrator per task — see fleet.ts header.
};

/**
 * Security Scanner Agent — vulnerability and secret detection.
 * Use for: CI checks, pre-release audits, dependency vulnerability scanning.
 */
export const SECURITY_SCANNER_AGENT: SubagentConfig = {
  id: 'security-scanner',
  name: 'Security Scanner',
  role: 'security-scanner',
  prompt: agentPrompt('security-scanner'),

  // Budgets are set by the orchestrator per task — see fleet.ts header.
};

/**
 * Shadow Agent — one-shot fleet monitoring and intervention.
 * Use for: quiet anomaly checks and on-demand intervention.
 */
export const SHADOW_AGENT: SubagentConfig = {
  id: 'shadow-agent',
  name: 'Shadow',
  role: 'shadow-agent',
  prompt: agentPrompt('shadow-agent'),

  // Budgets are set by the orchestrator per task — see fleet.ts header.
};

/**
 * Critic Agent — evaluates code quality, architecture decisions, and
 * refactoring plans against project conventions and engineering standards.
 * Use for: real-time evaluation of bug reports, refactor plans, and
 * architectural proposals during collaborative debugging sessions.
 */
export const CRITIC_AGENT: SubagentConfig = {
  id: 'critic',
  name: 'Critic',
  role: 'critic',
  prompt: agentPrompt('critic'),

  // Budgets are set by the orchestrator per task — see fleet.ts header.
};

/**
 * All agents in a map for easy lookup by role. The four legacy pre-built
 * agents plus the phase 1-9 catalog (`ALL_AGENT_DEFINITIONS`). Catalog roles
 * are guaranteed collision-free by the catalog builder; none overlap the
 * legacy four.
 */
export const FLEET_ROSTER: Record<string, SubagentConfig> = {
  'audit-log': AUDIT_LOG_AGENT,
  'bug-hunter': BUG_HUNTER_AGENT,
  'refactor-planner': REFACTOR_PLANNER_AGENT,
  'security-scanner': SECURITY_SCANNER_AGENT,
  'critic': CRITIC_AGENT,
  'shadow-agent': SHADOW_AGENT,
  ...Object.fromEntries(
    ALL_AGENT_DEFINITIONS.map((d) => [d.config.role as string, d.config] as const),
  ),
};

// ---------------------------------------------------------------------------
// Default per-role budgets.
//
// MASSIVELY RAISED from earlier values. User requested x5–x10 multiplier
// to prevent any timeout or budget exhaustion on long-running tasks
// like monorepo audits, deep refactors, and security scans.
//
// x10 values (realistic upper bound for a single subagent task):
//   audit-log:        7.5 hours, 5000 iterations, 15000 tool calls
//   bug-hunter:       10 hours,  8000 iterations, 20000 tool calls
//   refactor-planner: 7.5 hours, 6000 iterations, 18000 tool calls
//   security-scanner: 10 hours,  8000 iterations, 20000 tool calls
//
// These can be overridden per-call via delegate tool parameters.
// ---------------------------------------------------------------------------
export interface FleetRosterBudget {
  timeoutMs?: number | undefined;
  /** Idle reap window (ms). Resets on activity — see `applyRosterBudget`. */
  idleTimeoutMs?: number | undefined;
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
}

/**
 * Default idle window for delegated subagents: reap only after this long with
 * NO activity (no iteration / tool call / streamed progress). An actively-
 * working agent resets this clock continuously, so it runs until its task
 * naturally ends — no more wall-clock kills of productive runs. Power users
 * can still impose a hard `timeoutMs` per delegate.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export const FLEET_ROSTER_BUDGETS: Record<string, FleetRosterBudget> = {
  'audit-log': { timeoutMs: 7.5 * 60 * 60 * 1000, maxIterations: 5000, maxToolCalls: 15000 },
  'bug-hunter': { timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000 },
  'refactor-planner': { timeoutMs: 7.5 * 60 * 60 * 1000, maxIterations: 6000, maxToolCalls: 18000 },
  'security-scanner': { timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000 },
  'critic': { timeoutMs: 5 * 60 * 60 * 1000, maxIterations: 4000, maxToolCalls: 12000 },
  'shadow-agent': {
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    maxIterations: 2000,
    maxToolCalls: 5000,
    maxTokens: 60_000,
    maxCostUsd: 1,
  },
  ...Object.fromEntries(
    ALL_AGENT_DEFINITIONS.map((d) => [d.config.role as string, d.budget] as const),
  ),
};

/**
 * Apply roster budget to a config (only when the config has no explicit
 * budget fields set). This is called by the coordinator before dispatch.
 */
// Generic default budget applied when no role matches and no explicit budget
// fields are set. Used for `name` / free-form delegates. There is no default
// wall-clock timeout — a delegated agent runs until its task naturally ends
// (`end_turn`) or it stalls past the idle window. Iteration / tool-call ceilings
// remain as a runaway backstop.
const GENERIC_SUBAGENT_BUDGET: FleetRosterBudget = {
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  maxIterations: 5000,
  maxToolCalls: 15000,
};

export function applyRosterBudget(cfg: SubagentConfig): SubagentConfig {
  // First try role-specific budget; fall back to generic for name-only delegates.
  const roleBudget = cfg.role ? FLEET_ROSTER_BUDGETS[cfg.role] : undefined;
  const defaultBudget = roleBudget ?? (cfg.name ? GENERIC_SUBAGENT_BUDGET : undefined);
  if (!defaultBudget) return cfg;
  return {
    ...cfg,
    // Wall-clock cap is opt-in only: forward an explicit `cfg.timeoutMs`, but
    // do NOT impose the roster's historical multi-hour wall-clock default — it
    // killed agents that were still actively working. Reaping is idle-based.
    timeoutMs: cfg.timeoutMs,
    // Idle window is the default reaper. Resets on activity, so a long-but-
    // productive run is never killed; only a genuine stall is reaped.
    idleTimeoutMs: cfg.idleTimeoutMs ?? defaultBudget.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    maxIterations: cfg.maxIterations ?? defaultBudget.maxIterations,
    maxToolCalls: cfg.maxToolCalls ?? defaultBudget.maxToolCalls,
    maxTokens: cfg.maxTokens ?? defaultBudget.maxTokens,
    maxCostUsd: cfg.maxCostUsd ?? defaultBudget.maxCostUsd,
  };
}

/** Quick-access list for spawning all at once. */
export const ALL_FLEET_AGENTS = Object.values(FLEET_ROSTER);

// ---------------------------------------------------------------------------
// ACP external agents — WrongStack spawns these as subagents via ACP protocol.
// Each agent runs its own loop; WrongStack sends tasks as ACP messages and
// receives results. These don't go through makeAgentSubagentRunner — they
// are handled by makeACPSubagentRunner in the CLI multi-agent layer.
// ---------------------------------------------------------------------------

/**
 * Cline — ACP-compatible coding agent by @asonix.
 * Spawned as: `npx @agentify/cline`
 */
export const CLINE_AGENT: SubagentConfig = {
  id: 'cline',
  name: 'Cline',
  role: 'cline',
  prompt: agentPrompt('acp-cline'),
  provider: 'acp',
};

/**
 * Gemini CLI — Google's ACP-compatible command-line agent.
 * Spawned as: `gemini` (when gemini CLI is installed and in PATH)
 */
export const GEMINI_CLI_AGENT: SubagentConfig = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  role: 'gemini-cli',
  prompt: agentPrompt('acp-gemini-cli'),
  provider: 'acp',
};

/**
 * GitHub Copilot (public preview) — ACP-compatible Copilot CLI agent.
 * Spawned as: `gh copilot` (when gh CLI with copilot extension is installed)
 */
export const COPILOT_AGENT: SubagentConfig = {
  id: 'copilot',
  name: 'GitHub Copilot',
  role: 'copilot',
  prompt: agentPrompt('acp-copilot'),
  provider: 'acp',
};

/**
 * OpenHands — AI coding agent by all-in.ai, ACP-compatible.
 * Spawned as: `openhands` (when installed)
 */
export const OPENHANDS_AGENT: SubagentConfig = {
  id: 'openhands',
  name: 'OpenHands',
  role: 'openhands',
  prompt: agentPrompt('acp-openhands'),
  provider: 'acp',
};

/**
 * Goose — IDE agent by ExoRL, ACP-compatible.
 * Spawned as: `goose` (when goose CLI is installed)
 */
export const GOOSE_AGENT: SubagentConfig = {
  id: 'goose',
  name: 'Goose',
  role: 'goose',
  prompt: agentPrompt('acp-goose'),
  provider: 'acp',
};

/** All ACP external agents. */
export const ACP_AGENTS: SubagentConfig[] = [
  CLINE_AGENT,
  GEMINI_CLI_AGENT,
  COPILOT_AGENT,
  OPENHANDS_AGENT,
  GOOSE_AGENT,
];

// ACP agents share the same generous budgets as the built-in fleet agents.
// External ACP agents may need more time than typical in-process subagents
// since they run their own loops and may do tool-call round-trips.
FLEET_ROSTER_BUDGETS['cline'] = {timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000};
FLEET_ROSTER_BUDGETS['gemini-cli'] = {timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000};
FLEET_ROSTER_BUDGETS['copilot'] = {timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000};
FLEET_ROSTER_BUDGETS['openhands'] = {timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000};
FLEET_ROSTER_BUDGETS['goose'] = {timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000};

/** Extended roster including ACP agents. */
export const FLEET_ROSTER_WITHACP: Record<string, SubagentConfig> = {
  ...FLEET_ROSTER,
  ...Object.fromEntries(ACP_AGENTS.map((a) => [a.role as string, a])),
};
