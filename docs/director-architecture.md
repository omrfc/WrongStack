# Director Orchestration

A multi-agent system where every agent runs with its own **provider**, its
own **model**, its own **context**, its own **session file**, its own
**tool set**, and its own **budget** — and a **Director agent** (itself
an LLM) plans, spawns, supervises, redirects, and aggregates the work
across the fleet.

Status: **Phases 1, 3, 4, 5 shipped in 0.1.7** (see [CHANGELOG.md](../CHANGELOG.md)).
Phase 2 ships as `makeDirectorSessionFactory` (per-subagent JSONL). Phase 6
items — CLI `--director` flag, TUI/WebUI fleet panels, `wstack replay
<runId>` — are not yet started. The protocol and isolation invariants
are proven via 24 integration tests across core + CLI.

Builds on existing primitives in `packages/core/src/defaults/multi-agent-*`
and `packages/core/src/types/multi-agent.ts`.

---

## 1. Goals

| Goal | Why it matters |
|------|---|
| **Per-subagent provider + model** | Use Sonnet for code edits, Haiku for grep/summarize, Gemini for long-context audits, a local OSS model for cheap classification — in the same run. |
| **Per-subagent session JSONL** | Each subagent's transcript replays independently. Lets you fork a subagent's history, share just *its* trace with a teammate, or analyze cost per role. |
| **Per-subagent context window** | A 200k-context Sonnet child shouldn't be capped by an 8k Haiku sibling's window. Each agent's compaction policy runs on its own messages. |
| **LLM-driven Director** | The director isn't just a queue runner — it's a model that *decides* which subagent to spawn, *reads* their replies via the bridge, and *plans* next steps. Tool-driven, observable, debuggable. |
| **Streaming roll-up** | Director sees subagent output as it streams, not just final results. Enables early-cancel, redirect, and human-in-the-loop checkpoints. |
| **Provenance + cost attribution** | Total session cost is the sum of subtree costs; you can answer "what did the code-reviewer subagent cost across the last hour?" |
| **Crash-safe** | Director restart re-attaches to live subagents via their session JSONL — no work is silently lost. |

### Non-goals (for v1)

- **Cross-machine fleet.** All agents run in the same Node process. Distributed
  execution is a follow-up that adds network transport on top of `AgentBridge`.
- **Cycle protection.** Directors that spawn directors (recursive orchestration)
  are disallowed at depth > 2 by default — opt in via config.
- **Auto-failover between providers.** If a subagent's provider fails, the
  director sees the error and decides what to do (respawn, replace, ask user).
  No silent migration.

---

## 2. What already exists (don't reinvent)

| Primitive | File | Status |
|---|---|---|
| `MultiAgentCoordinator` | `packages/core/src/defaults/multi-agent-coordinator.ts` | ✅ queue + concurrency + budget + bridge |
| `SubagentBudget` | `packages/core/src/defaults/subagent-budget.ts` | ✅ iter/tool/token/cost/timeout enforcement |
| `AgentBridge` | `packages/core/src/defaults/agent-bridge.ts` | ✅ request/response + broadcast |
| `AutonomousRunner` | `packages/core/src/defaults/autonomous-runner.ts` | ✅ done-condition loop |
| `makeAgentSubagentRunner` | `packages/core/src/defaults/agent-subagent-runner.ts` | ✅ factory→fresh Agent per task, budget-wired |
| `SubagentConfig.model` | `packages/core/src/types/multi-agent.ts` | ✅ per-subagent model field |
| `tool.executed` events | `packages/core/src/core/agent.ts` | ✅ used for budget counting (post-BUG-001 fix) |

### Gaps the design closes

| Gap | What's missing |
|---|---|
| **Per-subagent provider** | `SubagentConfig` has `model` but no `provider`. Today every subagent uses the leader's provider. |
| **Per-subagent session** | `Agent` takes a single `SessionWriter` from `Context`. The factory has to construct one per child, but nothing in core enforces or *names* a child session. |
| **Director-as-agent** | There's a coordinator but no LLM driving it. The Director needs tools (`spawn`, `assign`, `ask`, `terminate`, `await`, `roll_up`) and a system prompt that explains the fleet. |
| **Streaming roll-up** | Subagent text/tool events fan out via their own EventBus; the director can't subscribe by default. |
| **Cost roll-up** | `TokenCounter` is per-agent. There's no parent-side aggregator. |
| **Replay across fleet** | Each subagent writes its own JSONL but nothing links them — no manifest "this director run spawned children X, Y, Z". |

---

## 3. Design

### 3.1 New types

```ts
// packages/core/src/types/multi-agent.ts (extend existing)

export interface SubagentConfig {
  // ...existing fields...
  /** NEW: per-subagent provider id (e.g. 'anthropic', 'openai', 'google',
   *  or any registered provider). Falls back to the coordinator's
   *  defaultProvider if absent. Combined with `model` gives full
   *  provider+model isolation. */
  provider?: string;

  /** NEW: per-subagent session directory override. Default is
   *  `<sessionsRoot>/<directorRunId>/<subagentId>.jsonl`. Useful when a
   *  subagent's transcript should live in a different namespace (e.g.
   *  archived to long-term storage immediately). */
  sessionPath?: string;

  /** NEW: per-subagent system-prompt overlay. Composed on top of the
   *  role's base prompt — does not replace it. */
  systemPromptOverride?: string;

  /** NEW: which compactor to use. Different roles benefit from different
   *  strategies (researcher = aggressive elision of tool outputs;
   *  code-editor = preserve diff trails). */
  compactorId?: 'selective' | 'intelligent' | 'none';
}

// New: per-subagent IO routing
export interface SubagentIO {
  /** Where subagent text streams. 'director' = forward to parent's bridge;
   *  'silent' = no forward (results only at end); 'user' = forward direct
   *  to the user-facing renderer. */
  textStream: 'director' | 'silent' | 'user';
  /** Same options, applied to tool.executed events. */
  toolStream: 'director' | 'silent' | 'user';
}

// New: director-specific config layered onto MultiAgentConfig
export interface DirectorConfig extends MultiAgentConfig {
  /** Provider+model the director itself runs on. Independent of every
   *  subagent. Defaults to the launching context's provider. */
  directorProvider?: string;
  directorModel?: string;

  /** Optional roster of pre-registered subagent configs. The director can
   *  spawn ad-hoc subagents too, but a roster gives it discoverable roles. */
  roster?: SubagentConfig[];

  /** Maximum subagent spawn depth. Hard-cap at 2 unless overridden. */
  maxSpawnDepth?: number;

  /** When true, the director's run.jsonl writes a manifest of every
   *  spawned child so a future replay can re-attach. */
  writeFleetManifest?: boolean;
}
```

### 3.2 New core class: `Director`

Lives at `packages/core/src/defaults/director.ts`. Think of it as an
`Agent` (it *is* one internally) whose tool set is the orchestration API.

```ts
export class Director {
  constructor(opts: {
    config: DirectorConfig;
    coordinator: MultiAgentCoordinator;
    factory: AgentFactory;                   // existing — builds isolated child agents
    sessionRoot: string;                     // where child JSONLs land
    providerRegistry: ProviderRegistry;      // resolves per-subagent providers
    events: EventBus;                        // fleet-wide event bus (director publishes)
  }) {}

  /**
   * Boot the director's own Agent. The director's tools (below) talk to
   * the coordinator. The director's session captures the *plan* — the
   * subagents' work lives in their own session files.
   */
  async run(initialInput: string, opts: { signal?: AbortSignal }): Promise<DirectorResult> { /*…*/ }
}
```

### 3.3 Director tools

The director's tool set is the orchestration API. These are normal
`Tool` implementations; they all have `permission: 'auto'` because the
*user* already approved running the director.

| Tool | Purpose |
|---|---|
| `spawn_subagent` | Create a subagent from a `SubagentConfig` (or a roster id). Returns subagent id. |
| `assign_task` | Hand a `TaskSpec` to a specific subagent (or let the coordinator pick by role). |
| `ask` | Synchronous request to a subagent via bridge — director waits for response. Used for "summarize what you found", "are you blocked?", etc. |
| `await_tasks` | Block until a set of `taskIds` complete (or timeout). Returns each task's result. |
| `roll_up` | Aggregate completed task results into a structured summary the director adds to its own context. |
| `terminate_subagent` | Send abort to a subagent. Cleans up budget + session-close. |
| `fleet_status` | Snapshot of `CoordinatorStatus` for in-prompt reasoning. |
| `subagent_session` | Read tail of a subagent's session JSONL (for retrospection or debugging). |
| `redirect` | Replace a running subagent's current task with a new one — graceful cancel + reassign. |

These live at `packages/tools/src/director-*.ts` and are registered only
on the director's tool registry, never the subagents' (subagents must
not recursively spawn unless explicitly configured).

### 3.4 Per-subagent provider plumbing

The current `AgentFactory` signature accepts `SubagentConfig`. Extend it
in the CLI/TUI's wiring:

```ts
// packages/cli/src/multi-agent.ts — extend factory
const factory: AgentFactory = async (config) => {
  // Resolve provider+model from registry; fall back to leader's.
  const provider = providerRegistry.get(config.provider ?? leaderProviderId);
  const model = config.model ?? leaderModel;

  // Per-subagent session writer — distinct JSONL, distinct in-memory
  // event buffer. Even sibling subagents in the same director run never
  // share a session writer.
  const sessionPath = config.sessionPath
    ?? join(sessionRoot, directorRunId, `${config.id ?? config.name}.jsonl`);
  const session = new DefaultSessionStore(sessionPath, { /*…*/ });

  // Per-subagent context — fresh tokenCounter, fresh tools array filtered
  // to the role's allowed names, fresh systemPrompt with the overlay.
  const ctx = new Context({
    systemPrompt: composeRolePrompt(config),
    provider,
    session,
    model,
    tools: filterTools(allTools, config.tools),
    tokenCounter: new DefaultTokenCounter(),
    signal: /* injected later */ new AbortController().signal,
    cwd,
    projectRoot,
  });

  const events = new EventBus();
  const agent = new Agent({ container, tools, providers, events, pipelines, context: ctx });
  return { agent, events };
};
```

### 3.5 Streaming roll-up

The director needs to see subagent activity *as it happens*. We layer a
small fan-in on top of each subagent's EventBus:

```ts
// packages/core/src/defaults/fleet-bus.ts (new)
export class FleetBus {
  // Subscribe to ALL events from a specific subagent.
  subscribe(subagentId: string, handler: (e: FleetEvent) => void): () => void;
  // Subscribe to a filtered slice (e.g. "all tool.executed across the fleet").
  filter(type: string, handler: (e: FleetEvent) => void): () => void;
}

export interface FleetEvent {
  subagentId: string;
  taskId?: string;
  ts: number;
  type: string;                  // 'provider.text_delta', 'tool.executed', etc.
  payload: unknown;
}
```

The `AgentFactory` registers each subagent's EventBus with the FleetBus
on creation. The Director and the TUI/WebUI subscribe — the TUI's
multi-agent panel renders the streaming view directly off this bus.

### 3.6 Cost & token roll-up

Each subagent has its own `TokenCounter`. The director maintains a
roll-up:

```ts
export interface FleetUsage {
  total: { input: number; output: number; cacheRead?: number; cost: number };
  perSubagent: Record<string, {
    provider: string; model: string;
    input: number; output: number; cacheRead?: number;
    cost: number;
    elapsedMs: number;
    toolCalls: number;
  }>;
}
```

`FleetBus` emits `provider.response` for every subagent; a small
aggregator subscribes and updates `FleetUsage`. The director's
`fleet_status` tool returns this — so the director can reason about
budgets ("the researcher has already burned $0.40; let me prefer
summarization tools for the next task").

### 3.7 Session manifest

When `writeFleetManifest: true`, the director's session writes a
`fleet.json` next to its JSONL:

```json
{
  "directorRunId": "20260515-abcd1234",
  "directorSession": ".wrongstack/sessions/20260515-abcd1234.jsonl",
  "children": [
    {
      "subagentId": "researcher-1",
      "role": "researcher",
      "provider": "anthropic", "model": "claude-haiku-4-5",
      "sessionPath": ".wrongstack/sessions/20260515-abcd1234/researcher-1.jsonl",
      "tasks": ["t-001", "t-005"],
      "status": "done"
    },
    /* … */
  ]
}
```

A future `wstack replay <directorRunId>` can rehydrate the whole fleet.

---

## 4. End-to-end flow

User runs: *"Audit this codebase for OWASP issues. Summarize per-package, then write the cross-cutting risks to security-findings.md."*

```
1. CLI bootstraps Director with config.directorModel='claude-sonnet-4-6'
   and roster = [researcher, code-auditor, writer].

2. Director's first turn:
   - Reads project tree via fleet_status (which preloads cwd info).
   - Calls spawn_subagent twice:
       researcher-1 → Haiku-4.5 on package: packages/core
       researcher-2 → Haiku-4.5 on package: packages/tools
   - Calls assign_task for each, with detailed scope.

3. Each researcher runs in its own Agent, isolated:
   - Own context window, own session JSONL.
   - Streams text/tool events to FleetBus.
   - Director subscribes via filter('provider.text_delta', ...)
     and can decide to redirect mid-stream if a researcher goes
     off-track.

4. Director awaits via await_tasks(['t-001', 't-002']).
   FleetBus continuously feeds it the streaming activity (rendered
   in the TUI's multi-agent panel; the director's actual prompt
   only includes tool.executed summaries to keep token usage sane).

5. As researchers finish, Director calls roll_up — pulls each
   TaskResult.result into its context as a structured "Findings from
   researcher-1: …" block.

6. Director spawns code-auditor (Sonnet, full context) with the
   roll-up as input. Code-auditor produces canonical risk taxonomy.

7. Director spawns writer (Haiku, cheap) with the auditor's output
   and asks it to render security-findings.md via a bash-tool
   write_file.

8. Director's final message to the user summarizes:
   - 2 researchers, 1 auditor, 1 writer = 4 subagents
   - Total cost: $0.31 across 3 providers (anthropic-haiku, anthropic-sonnet)
   - Findings file at security-findings.md
   - Replay artifact: ~/.wrongstack/sessions/20260515-abcd1234/
```

---

## 5. Lifecycle invariants

1. **Subagent isolation.** Two siblings never share a `Context`,
   `SessionWriter`, `TokenCounter`, or in-flight tool state. They can
   only communicate via `AgentBridge` (parent-mediated).

2. **Provider isolation.** If subagent A uses anthropic-sonnet and
   subagent B uses openai-gpt-5, A's API key and rate-limit retries
   are scoped to anthropic's provider instance. A failing provider
   does not corrupt the other.

3. **Budget is final.** Once a subagent's `SubagentBudget` trips
   `BudgetExceededError`, the coordinator marks the task `failed` or
   `timeout` and won't auto-retry. Director may *decide* to respawn,
   but that's an explicit call, not magic.

4. **Sessions never merge.** Director's session captures *its own*
   prompt-and-decision trace plus tool calls to the orchestration
   tools. Subagent sessions are independent JSONL files. The fleet
   manifest is the only link.

5. **Abort cascade.** Aborting the director aborts the coordinator,
   which aborts every subagent's AbortController. Conversely, a
   subagent aborting itself does *not* abort siblings.

6. **Spawn depth cap.** Default 2 levels (user → director → leaves).
   Recursive directors require explicit `maxSpawnDepth: 3` and a
   warning in the system prompt.

---

## 6. Implementation phases

### Phase 1 — Provider plumbing ✅ shipped (0.1.7)

- [x] `provider?: string` added to `SubagentConfig`
      ([packages/core/src/types/multi-agent.ts](../packages/core/src/types/multi-agent.ts))
- [x] CLI's `MultiAgentHost.buildSubagentProvider` honors `config.provider`
      with `config.providers[<id>]` lookup + leader fallback
      ([packages/cli/src/multi-agent.ts](../packages/cli/src/multi-agent.ts))
- [x] `/spawn --provider=<id> --model=<id>` slash command
      ([packages/cli/src/slash-commands/index.ts](../packages/cli/src/slash-commands/index.ts))
- [x] Tests: 2 CLI per-provider routing + 1 director provider attribution

### Phase 2 — Per-subagent sessions ✅ shipped (0.1.7)

- [x] `makeDirectorSessionFactory` produces `<runDir>/<subagentId>.jsonl`
      ([packages/core/src/defaults/director-session.ts](../packages/core/src/defaults/director-session.ts))
- [x] Test: 2 subagents in one director run, each JSONL contains only
      its own events (cross-content rejected)
- [ ] CLI subcommand `wstack sessions ls <runId>` — not yet started

### Phase 3 — FleetBus + roll-up ✅ shipped (0.1.7)

- [x] `FleetBus.subscribe(subagentId, handler)` / `.filter(type, handler)` /
      `.onAny(handler)` / `.attach(subagentId, bus, taskId?)`
      ([packages/core/src/defaults/fleet-bus.ts](../packages/core/src/defaults/fleet-bus.ts))
- [x] `FleetUsageAggregator` subscribes to `provider.response` +
      `tool.executed` + `iteration.started` and rolls up per-subagent +
      total
- [x] Test: pricing-driven cost roll-up across 2 subagents with distinct
      provider/model
- [ ] TUI/WebUI fleet panel — not yet started

### Phase 4 — Director tools ✅ shipped (0.1.7)

- [x] 8 tools: `spawn_subagent`, `assign_task`, `await_tasks`,
      `ask_subagent`, `roll_up`, `terminate_subagent`, `fleet_status`,
      `fleet_usage`
- [x] `Director.tools(roster?)` returns the array ready for an Agent's
      `ToolRegistry`
- [x] Tests for all 8 tools' input/output shapes + roster lookup +
      unknown-role error path
- [ ] Director system-prompt template — to follow when CLI wiring lands

### Phase 5 — Wiring & UX (partially shipped)

- [x] `Director` class composes `MultiAgentCoordinator` + `FleetBus` +
      `FleetUsageAggregator` + `InMemoryBridgeTransport` and exposes
      both an imperative API and the LLM-callable tool set
- [x] `Director.shutdown()` stops every subagent, closes every bridge,
      writes manifest
- [x] `Director.writeManifest()` emits `fleet.json` (directorRunId,
      children with provider/model/role/tasks, full FleetUsage)
- [ ] CLI flag `--director` and config block `director.*`
- [ ] TUI multi-agent panel
- [ ] WebUI fleet tab
- [ ] `wstack replay <runId>`
- [ ] Tutorial doc walking through the OWASP audit example

### Phase 6 — Safety & polish

- [ ] `maxSpawnDepth` enforcement at `spawn_subagent` tool layer
- [ ] Quota guard: `directorBudget` separate from individual subagent
      budgets — cap on total fleet cost
- [ ] Crash recovery: `--resume <runId>` re-attaches to any subagent
      whose lock is fresh
- [ ] Hostile-prompt test pack: subagent tries to exfiltrate parent's
      context via bridge; verify the bridge contract refuses

---

## 7. Open questions

1. **Director-to-director.** Allow a researcher to itself spawn a
   director? Probably not — keeps the topology a tree. Hard-cap at 1
   director per run in v1, configurable in v2.

2. **Shared memory.** Should subagents share `MemoryStore` notes
   (project + user memory)? Lean toward **yes for project memory, no
   for user memory** — the user's private notes shouldn't leak across
   agent boundaries.

3. **Provider key reuse.** Two anthropic subagents share the same
   API key entry but should they share rate-limit windows? Yes — they
   should share the *retry queue* via the provider instance (which is
   already singleton per provider id), so a 429 throttles all
   anthropic subagents together.

4. **Streaming back to user.** The director's own text streams to the
   user. Should the director also be allowed to forward a subagent's
   stream directly ("here's what the researcher just said, live")?
   Useful but invites confusing UIs — gate behind `SubagentIO.textStream
   === 'user'` and warn at config time.

5. **Cost cap behavior.** When the fleet cost cap trips, do we cancel
   in-flight tasks or let them complete? Default: let in-flight
   complete, refuse new spawns, surface the cap to the director so it
   can roll up gracefully.

---

## 8. Why this design

- **Builds on existing primitives.** The coordinator, budget, bridge,
  and autonomous-runner already handle 70% of the mechanics. The new
  code is concentrated in (a) per-subagent provider+session wiring,
  (b) the Director class + tools, (c) FleetBus + roll-up.
- **Each gap has a clear test.** Provider plumbing, session isolation,
  budget enforcement, streaming roll-up — all unit-testable.
- **No magic.** The director is just an Agent with a different tool
  set. Anyone who understands `Agent` understands the director.
- **Cost-aware by construction.** Per-subagent `TokenCounter` rolls up
  into `FleetUsage`. The director can reason about money in its prompt.
- **Replay-friendly.** Fleet manifest + per-subagent JSONL = full
  reconstruction of any director run.

---

*Owner: TBD. Track progress in a follow-up `bugs.md`-style triage
once Phase 1 lands.*
