/**
 * System-prompt composition helpers for the Director ecosystem.
 *
 * Two callers need composed prompts:
 *
 *   1. The **leader** (the director's own Agent) — needs a preamble that
 *      explains the fleet protocol: when to spawn, when to await, how to
 *      roll up, and the eight orchestration tools it owns.
 *
 *   2. Each **subagent** — needs a baseline that explains it has a parent
 *      it can call via the bridge, a role-specific block, the task brief,
 *      and finally any per-spawn `systemPromptOverride` from `SubagentConfig`.
 *
 * Both composers are pure functions: feed them parts, they return a string.
 * No I/O, no side effects, no implicit defaults beyond the ones exported
 * here. Callers (CLI multi-agent factory, Director itself) decide which
 * parts to fill in — that keeps the composition seam visible and testable.
 */

/**
 * Default fleet-protocol preamble injected at the **front** of the
 * director-agent's system prompt. Kept deliberately short — long preambles
 * crowd out the user's leader prompt and the LLM stops attending. The tool
 * descriptions live on the tool definitions themselves; this preamble only
 * teaches *when* to reach for them.
 */
export const DEFAULT_DIRECTOR_PREAMBLE = `\
You are the Director of a multi-agent fleet. You orchestrate worker
subagents by spawning them, assigning tasks, awaiting completions, and
rolling up their outputs into your next decision.

Core fleet tools available to you:
  - spawn_subagent       — create a worker with a chosen provider / model / role
  - assign_task          — hand a piece of work to a specific subagent
  - await_tasks          — block until named task ids complete (parallel-safe)
  - ask_subagent         — synchronously query a running subagent via the bridge
  - roll_up              — aggregate finished tasks into a markdown/json summary
  - terminate_subagent   — abort a stuck worker (use sparingly)
  - fleet_status         — snapshot of all subagents and pending tasks
  - fleet_usage          — token + cost breakdown per subagent and total

Working rules:
  1. Decompose first. Before spawning, decide which sub-tasks are
     independent and can run in parallel. Sequential work doesn't need a
     subagent — do it yourself.
  2. Match worker to job. Cheap/fast model for triage, capable model for
     synthesis. Different providers per sibling is allowed and encouraged.
  3. Always pair an assign with an await. Don't fire-and-forget; you owe
     the user a single coherent answer at the end.
  4. Roll up before deciding. After await_tasks resolves, call roll_up so
     the results are folded back into your context in a compact form.
  5. Budget is real. Check fleet_usage periodically. If a subagent is
     thrashing, terminate it rather than letting cost climb silently.
  6. Never claim a subagent's work as your own without verifying it. If a
     result looks wrong, ask_subagent for clarification before passing it
     to the user.\
`;

/**
 * Default baseline prepended to every subagent's system prompt. Tells the
 * subagent its place in the hierarchy and the bridge contract — without
 * this, a subagent has no way to know it *can* ask the parent for
 * clarification, and it will hallucinate answers when context is missing.
 *
 * Bridge contract: subagents may `send` progress and `request` answers, but
 * MAY NOT exfiltrate the parent's full system prompt or tools list. The
 * baseline reinforces this in plain text — the actual enforcement is at
 * the bridge transport layer.
 */
export const DEFAULT_SUBAGENT_BASELINE = `\
You are a subagent operating under a Director. You were spawned to handle
a specific slice of a larger plan — do that slice well and report back.

Bridge contract:
  - You have a parent (the Director). You may call \`request\` on the
    parent bridge to ask a clarifying question. Use this sparingly; the
    parent is also working.
  - You MAY NOT request the parent's system prompt, tool list, or other
    subagents' context. Those are not yours to read.
  - Your final task output is what the Director sees. Be concise,
    structured, and self-contained — assume the Director will paste your
    output into its own context.\
`;

/** Parts the leader-prompt composer accepts. All optional. */
export interface DirectorPromptParts {
  /** The user's existing leader system prompt — typically what was passed
   *  via `MultiAgentConfig.leaderSystemPrompt`. */
  basePrompt?: string;
  /** Override the built-in fleet preamble. Pass empty string to suppress. */
  directorPreamble?: string;
  /** Optional roster summary block — a short list of pre-configured roles
   *  the director can spawn (e.g. "researcher, coder, reviewer"). Helps
   *  small models discover the available shapes without scanning tools. */
  rosterSummary?: string;
}

/**
 * Compose the leader/director's system prompt. Order:
 *   1. Director preamble (fleet protocol)
 *   2. Roster summary (optional, when provided)
 *   3. User base prompt (the per-project leader prompt)
 *
 * Sections are separated by a blank line. Empty parts are skipped so the
 * output never contains stray blank-line runs.
 */
export function composeDirectorPrompt(parts: DirectorPromptParts = {}): string {
  const sections: string[] = [];
  const preamble = parts.directorPreamble ?? DEFAULT_DIRECTOR_PREAMBLE;
  if (preamble && preamble.trim().length > 0) sections.push(preamble.trim());
  if (parts.rosterSummary && parts.rosterSummary.trim().length > 0) {
    sections.push(`Available roles you can spawn:\n${parts.rosterSummary.trim()}`);
  }
  if (parts.basePrompt && parts.basePrompt.trim().length > 0) {
    sections.push(parts.basePrompt.trim());
  }
  return sections.join('\n\n');
}

/** Parts the subagent-prompt composer accepts. Layered from generic to
 *  specific; later layers override earlier ones when they conflict. */
export interface SubagentPromptParts {
  /** Base persona/identity for *every* subagent. Defaults to the bridge
   *  contract baseline. Pass empty string to suppress. */
  baseline?: string;
  /** Role-specific block, e.g. "You are a code reviewer. Focus on…". */
  role?: string;
  /** Task brief — usually the same string the runner passes as user input,
   *  but exposed here in case the factory wants it duplicated in the
   *  system prompt for reinforcement. */
  task?: string;
  /** Final per-spawn override from `SubagentConfig.systemPromptOverride`.
   *  Added last so it wins on conflict — that's by design: the spawn site
   *  knows the most about what this specific subagent should do. */
  override?: string;
}

/**
 * Compose a subagent's system prompt. Order:
 *   1. Baseline (bridge contract)
 *   2. Role
 *   3. Task brief
 *   4. Per-spawn override
 *
 * Same blank-line-separated joining as the director composer.
 *
 * Layering rationale: the baseline never needs to change between
 * subagents; the role is the "what kind of worker is this"; the task is
 * the "what should you do *now*"; the override is the spawn-site escape
 * hatch ("…and respond only in JSON"). Putting override last means it
 * never gets squashed by something earlier in the chain.
 */
export function composeSubagentPrompt(parts: SubagentPromptParts = {}): string {
  const sections: string[] = [];
  const baseline = parts.baseline ?? DEFAULT_SUBAGENT_BASELINE;
  if (baseline && baseline.trim().length > 0) sections.push(baseline.trim());
  if (parts.role && parts.role.trim().length > 0) {
    sections.push(`Role:\n${parts.role.trim()}`);
  }
  if (parts.task && parts.task.trim().length > 0) {
    sections.push(`Task:\n${parts.task.trim()}`);
  }
  if (parts.override && parts.override.trim().length > 0) {
    sections.push(parts.override.trim());
  }
  return sections.join('\n\n');
}

/**
 * Render a short bullet list summarising a roster — useful for stuffing
 * into `composeDirectorPrompt({ rosterSummary })` so the director model
 * can see available roles without scanning tool descriptions.
 *
 * Each entry: `- <role-id>: <name>[ (provider/model)] — <prompt-headline>`
 * The prompt headline is the first non-empty line of `config.prompt`,
 * truncated to 80 chars. Skipped entirely when the role has no prompt.
 */
export function rosterSummaryFromConfigs(
  roster: Record<string, { name: string; provider?: string; model?: string; prompt?: string; role?: string }>,
): string {
  const lines: string[] = [];
  for (const [roleId, cfg] of Object.entries(roster)) {
    const tag = cfg.provider && cfg.model ? ` (${cfg.provider}/${cfg.model})` : '';
    const headline = cfg.prompt
      ? (cfg.prompt.split('\n').find((l) => l.trim().length > 0) ?? '').trim().slice(0, 80)
      : '';
    const tail = headline ? ` — ${headline}` : '';
    lines.push(`- ${roleId}: ${cfg.name}${tag}${tail}`);
  }
  return lines.join('\n');
}
