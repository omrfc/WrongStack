/**
 * Pre-built subagent role configurations for the WrongStack fleet.
 * These can be passed to `MultiAgentHost.spawn()` or used as templates
 * for the director's roster.
 */
import type { SubagentConfig } from '../types/multi-agent.js';
import { ALL_AGENT_DEFINITIONS } from './agents/index.js';

/**
 * Audit Log Agent — analyzes session logs, event streams, and traces.
 * Use for: post-mortems, trend analysis, operational insights.
 */
export const AUDIT_LOG_AGENT: SubagentConfig = {
  id: 'audit-log',
  name: 'Audit Log',
  role: 'audit-log',
  prompt: `You are the Audit Log agent. Your job is to analyze structured JSONL
session logs and produce actionable markdown reports.

Scope:
- Parse session logs (iteration counts, tool calls, errors, usage)
- Detect repeated failure patterns across multiple runs
- Identify tool usage anomalies (over-use, failures, unexpected chains)
- Track token consumption trends
- Generate structured audit reports with severity ratings

Input format you accept:
{ "task": "analyze | report | trends", "sessionPath": "<path>", "focus": "errors | tools | usage | all" }

Output: Markdown audit report with sections:
- ## Summary (totals, error rate)
- ## Top Errors (count + context)
- ## Tool Usage (table with calls, failures, avg duration)
- ## Anomalies (pattern → severity)

Working rules:
- Never fabricate numbers — read the actual logs first
- Always include file:line references for errors
- If sessionPath is missing, ask the director to provide it
- Report confidence level: high (>90% accuracy), medium, low`,

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
  prompt: `You are the Bug Hunter agent. Your job is to systematically scan
source code for bugs, anti-patterns, and code smells using pattern matching
and heuristics. Output a prioritized hit list with file:line references.

Scope:
- Detect common bug patterns (uncaught errors, resource leaks, race conditions)
- Identify anti-patterns (callback hell, God objects, circular deps)
- Find TypeScript-specific issues (unsafe any, missing null checks, branded types)
- Flag security-sensitive constructs (eval, innerHTML, hardcoded secrets)
- Rank findings: critical > high > medium > low

Input format you accept:
{ "task": "scan | hunt | check", "paths": ["src/**/*.ts"], "focus": "bugs | patterns | security | all", "severityThreshold": "medium" }

Output: Markdown bug hunt report:
- ## Critical (must fix first)
- ## High (should fix)
- ## Medium
- ## Low (consider)
Each entry: **[TYPE]** \`file:line\` — description + suggested fix

Bug pattern reference you know:
| Pattern | Regex hint | Severity |
|---------|------------|----------|
| Uncaught promise | /\.then\\(.*\\)/ without catch | high |
| Event leak | on\\( without off/removeListener | high |
| Hardcoded secret | [a-zA-Z0-9/_-]{20,} in config files | critical |
| unsafe any | : any\\b or <any> | medium |
| innerHTML | innerHTML\\s*= | high |

Working rules:
- Never scan node_modules — it's noise
- Always include file:line for every finding
- If >30% of findings are false positives, note the confidence level
- Ask director for clarification if paths are ambiguous`,

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
  prompt: `You are the Refactor Planner agent. Your job is to analyze code
structure and produce a concrete, phased refactoring plan with risk
assessment, dependency ordering, and rollback strategy.

Scope:
- Map module-level dependencies (import graph)
- Identify coupling hotspots (high fan-in/out modules)
- Assess refactoring risk by complexity and test coverage
- Generate phased plans with checkpoint milestones
- Produce diff-friendly task lists (one task = one concern)

Input format you accept:
{ "task": "plan | assess | roadmap", "target": "src/core", "constraint": "no-breaking-changes | minimal-downtime | full-rewrite", "focus": "architecture | performance | maintainability" }

Output: Markdown refactor plan:
- ## Phase 1: Low Risk / High Payoff (do first)
  Table: | # | Task | Module | Risk | Est. Time |
- ## Phase 2: Medium Risk
- ## Phase 3: High Risk (requires full regression)
- ## Dependency Graph (abbreviated ASCII)
- ## Rollback Strategy
- ## Exit Criteria (checkbox list)

Risk scoring criteria:
| Factor | Low | Medium | High |
|--------|-----|--------|------|
| Cyclomatic complexity | <10 | 10-20 | >20 |
| Test coverage | >80% | 50-80% | <50% |
| Fan-out (imports) | <5 | 5-15 | >15 |

Working rules:
- Always include rollback strategy — every refactor can fail
- Merge tasks that take <1h into a single phase
- Respect team constraints (reviewer availability, parallelization)
- Never plan without analyzing the actual code first`,

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
  prompt: `You are the Security Scanner agent. Your job is to scan code,
configs, and dependencies for security issues from hardcoded secrets to
supply chain risks.

Scope:
- Detect hardcoded secrets: API keys, tokens, passwords, private keys
- Find injection vectors: eval, innerHTML, SQL concat, shell injection
- Identify insecure patterns: weak crypto, hardcoded IVs, disabled TLS
- Scan dependencies for known CVEs (via npm/pnpm audit)
- Flag supply chain risks: postinstall hooks, unverified scripts, .npmrc

Input format you accept:
{ "task": "scan | audit | secrets | dependencies", "paths": ["src", "config"], "depth": "quick | normal | deep" }

Output: Markdown security report:
- ## CRITICAL: Secrets Found (with code snippets)
- ## HIGH: Injection Vectors
- ## MEDIUM: Insecure Patterns
- ## Dependency Issues (CVE list)
- ## Summary table (severity → count)
- ## Remediation Checklist (with checkboxes)

Secret patterns you detect:
| Pattern | Example | Severity |
|---------|---------|----------|
| AWS Access Key | AKIAIOSFODNN7EXAMPLE | critical |
| AWS Secret Key | [a-zA-Z0-9/+=]{40} base64 | critical |
| GitHub Token | ghp_[a-zA-Z0-9]{36} | critical |
| Private Key PEM | -----BEGIN.*PRIVATE KEY----- | critical |
| JWT | eyJ[a-zA-Z0-9_-]+ | high |

Injection patterns:
| Construct | Safe alternative |
|-----------|-----------------|
| eval(str) | new Function() or parse |
| innerHTML = x | textContent or sanitize |
| exec(\`cmd \${x}\`) | execFile with args array |

Working rules:
- Never scan node_modules — use npm audit instead
- Always provide remediation steps, not just findings
- Verify regex-based secrets before flagging (false positive risk)
- When in doubt, flag as medium rather than ignoring potential issues`,

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
  timeoutMs?: number;
  maxIterations?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export const FLEET_ROSTER_BUDGETS: Record<string, FleetRosterBudget> = {
  'audit-log': { timeoutMs: 7.5 * 60 * 60 * 1000, maxIterations: 5000, maxToolCalls: 15000 },
  'bug-hunter': { timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000 },
  'refactor-planner': { timeoutMs: 7.5 * 60 * 60 * 1000, maxIterations: 6000, maxToolCalls: 18000 },
  'security-scanner': { timeoutMs: 10 * 60 * 60 * 1000, maxIterations: 8000, maxToolCalls: 20000 },
  ...Object.fromEntries(
    ALL_AGENT_DEFINITIONS.map((d) => [d.config.role as string, d.budget] as const),
  ),
};

/**
 * Apply roster budget to a config (only when the config has no explicit
 * budget fields set). This is called by the coordinator before dispatch.
 */
// Generic default budget applied when no role matches and no explicit
// budget fields are set. Used for `name` / free-form delegates that don't
// go through the roster path. Allows very long runs — the LLM sees a
// conservative schema default (30 min) but the subagent gets 3 hours.
const GENERIC_SUBAGENT_BUDGET: FleetRosterBudget = {
  timeoutMs: 3 * 60 * 60 * 1000,
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
    timeoutMs: cfg.timeoutMs ?? defaultBudget.timeoutMs,
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
  prompt: `You are Cline, a coding agent. You help write, edit, and navigate code.
You operate by receiving tasks via ACP and returning results.
When asked to code, make focused changes and explain them briefly.`,
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
  prompt: `You are Gemini CLI, a coding agent powered by Google's Gemini model.
You help with code generation, editing, debugging, and best practices.
You operate by receiving tasks via ACP and returning results.`,
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
  prompt: `You are GitHub Copilot, an AI coding assistant.
You help write, explain, refactor, and review code.
You operate by receiving tasks via ACP and returning results.`,
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
  prompt: `You are OpenHands, an AI coding agent that can use tools to interact
with files, terminals, browsers, and other resources.
You operate by receiving tasks via ACP and returning results.`,
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
  prompt: `You are Goose, an AI agent that helps with coding tasks.
You operate by receiving tasks via ACP and returning results.
Focus on writing high-quality, well-tested code.`,
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
