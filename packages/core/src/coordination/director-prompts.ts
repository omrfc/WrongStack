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
     to the user.
  7. **Act on subagent mail immediately**. Subagent messages (result, ask,
     assign, note) are injected inline before every step — even mid-task.
     When you see one, address it before continuing: reply to asks, factor
     in results, act on assignments. Use \`mailbox action=ack\` to mark
     completed messages.
  8. Wind down when satisfied. When the results are good enough, call
     work_complete — no new subagents will spawn and queued tasks complete
     as aborted. Running subagents finish naturally. Call terminate_subagent
     only for ones you need to stop immediately.\
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

Capabilities & operating rules:
  - You have full developer tools for your task: read, write/edit, search,
    shell + build (lint, format, typecheck, test), and dependency install.
    Use them directly to finish the task end-to-end. You run non-interactively
    — there is no human to approve individual tool calls, so routine work is
    pre-authorized; do not stop to ask for permission to read, edit, or build.
  - Stay inside the project root. Do not write files outside the repository,
    and do not touch machine config, credentials, or global state — those
    require an explicit grant you do not have.
  - Prefer the least-destructive path. Do not run irreversible or destructive
    commands (e.g. \`rm -rf\`, \`git push --force\`, history rewrites, dropping
    databases, mass deletes) unless the task explicitly requires it and names
    the target.
  - When you change code, verify it: run the relevant build / typecheck / tests
    and fix what you broke before reporting done.
  - Make only the changes the task calls for — don't refactor or reformat
    unrelated code.

Bridge contract:
  - You have a parent (the Director). You may call \`request\` on the
    parent bridge to ask a clarifying question. Use this sparingly; the
    parent is also working.
  - You MAY NOT request the parent's system prompt, tool list, or other
    subagents' context. Those are not yours to read.
  - Your final task output is what the Director sees. Be concise,
    structured, and self-contained — assume the Director will paste your
    output into its own context.

CRITICAL CONSTRAINT — NO FURTHER DELEGATION:
  - You MUST NOT call the \`delegate\` tool or attempt to spawn subagents.
  - You MUST NOT use \`spawn_subagent\`, \`assign_task\`, or any equivalent.
  - Your role is to execute the assigned task yourself, not to orchestrate.
  - If a subtask is too complex, report back to the Director with what you
    found and let the Director decide how to decompose.

Inter-agent mailbox (if you have the \`mail_send\`/\`mail_inbox\`/\`mailbox\` tools):
  - You are part of a project-wide fleet that may span other terminals and
    WebUIs. Your mailbox identity is \`<your-name>@<session-tag>\` (unique
    per session); mail addressed to you, to your bare name, or broadcast
    to \`*\` is injected into your conversation automatically before each
    step — read it once, it is marked read.
  - Broadcast milestones: when you complete a significant piece of work,
    \`mail_send to="*"\` a one-line summary so parallel agents don't collide
    with or duplicate it.
  - Hand off matching work: if another online agent's role fits a follow-up
    better (e.g. a reviewer while you just wrote code), \`mail_send\` it to
    their exact id instead of doing everything yourself. Discover ids with
    \`mailbox action=online\`.
  - Answer your mail: reply to the sender's exact \`from\` id. When done with
    an assigned task, post a \`result\` back to whoever assigned it.
  - **Mail to the leader is always seen**: when you send \`ask\`, \`result\`,
    or \`assign\` to the director/leader, the message is injected inline into
    the leader's conversation before their next step — even if the leader is
    mid-task. Use \`mail_send\` to reliably reach the leader instead of
    waiting for them to check in.\
`;

/** Parts the leader-prompt composer accepts. All optional. */
export interface DirectorPromptParts {
  /** The user's existing leader system prompt — typically what was passed
   *  via `MultiAgentConfig.leaderSystemPrompt`. */
  basePrompt?: string | undefined;
  /** Override the built-in fleet preamble. Pass empty string to suppress. */
  directorPreamble?: string | undefined;
  /** Optional roster summary block — a short list of pre-configured roles
   *  the director can spawn (e.g. "researcher, coder, reviewer"). Helps
   *  small models discover the available shapes without scanning tools. */
  rosterSummary?: string | undefined;
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
  baseline?: string | undefined;
  /** Role-specific block, e.g. "You are a code reviewer. Focus on…". */
  role?: string | undefined;
  /** Task brief — usually the same string the runner passes as user input,
   *  but exposed here in case the factory wants it duplicated in the
   *  system prompt for reinforcement. */
  task?: string | undefined;
  /**
   * Absolute path to a shared scratchpad directory the whole fleet can
   * read/write. When set, the composer adds a "Shared notes" block that
   * tells the subagent where to drop findings and where to look for
   * sibling output. This is the cheap fleet-coordination channel —
   * agents don't need each other's transcripts, just each other's
   * conclusions. Falls between `task` and `override` so the override
   * can still narrow or replace it.
   */
  sharedScratchpad?: string | undefined;
  /**
   * Optional skill body content injected into the subagent's system prompt.
   * Use this to provide domain-specific knowledge (SKILL.md bodies) to
   * subagents that need it. Placed after `sharedScratchpad` and before
   * `override` so the override can still narrow or replace it.
   */
  skills?: string | undefined;
  /** Final per-spawn override from `SubagentConfig.systemPromptOverride`.
   *  Added last so it wins on conflict — that's by design: the spawn site
   *  knows the most about what this specific subagent should do. */
  override?: string | undefined;
}

/**
 * Compose a subagent's system prompt. Order:
 *   1. Baseline (bridge contract)
 *   2. Role
 *   3. Task brief
 *   4. Shared scratchpad
 *   5. Skills (domain knowledge from SKILL.md)
 *   6. Per-spawn override
 *
 * Same blank-line-separated joining as the director composer.
 *
 * Layering rationale: the baseline never needs to change between
 * subagents; the role is the "what kind of worker is this"; the task is
 * the "what should you do *now*"; skills provide reusable domain knowledge
 * (e.g. bug-hunting patterns, security scanning rules); the override is
 * the spawn-site escape hatch ("…and respond only in JSON"). Putting
 * override last means it never gets squashed by something earlier in the chain.
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
  if (parts.sharedScratchpad && parts.sharedScratchpad.trim().length > 0) {
    sections.push(
      `Shared notes:\n` +
        `A scratchpad shared with the rest of the fleet is mounted at \`${parts.sharedScratchpad.trim()}\`.\n` +
        `- Write your final findings as markdown files there (e.g. \`findings.md\`, \`security.md\`).\n` +
        `- Before starting, list the directory and read any sibling files relevant to your task — ` +
        `they may already contain context you can build on.\n` +
        `- Use stable filenames (one file per concern); overwrite instead of appending so the ` +
        `Director sees the latest state.`,
    );
  }
  if (parts.skills && parts.skills.trim().length > 0) {
    sections.push(`Domain knowledge:\n${parts.skills.trim()}`);
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
  roster: Record<
    string,
    { name: string; provider?: string | undefined; model?: string | undefined; prompt?: string | undefined; role?: string | undefined }
  >,
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
