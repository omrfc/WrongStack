# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`@wrongstack/runtime` host composition package.** Runtime is now the
  migration target for concrete defaults and host assembly helpers, keeping
  `@wrongstack/core` focused on kernel contracts, registries, primitives, and
  the agent lifecycle. The first slice re-exports the current defaults from
  `@wrongstack/core/defaults` and introduces the `WrongStackPack` extension
  shape for tools, providers, slash commands, and lifecycle hooks.
- **Built-in tools pack.** `@wrongstack/tools/pack` now exports
  `builtinToolsPack`; CLI and WebUI register built-ins through that pack shape
  instead of hard-wiring the raw tool array. This is the first package-level
  step toward CLI, TUI, WebUI, Telegram, and future hosts acting as extension
  packages around a small core.
- **Compact multi-agent activity memory.** The TUI tracks the last two tool
  calls and last two assistant text snippets per subagent. `LiveActivityStrip`
  and `FleetPanel` render those compact summaries so users can see what each
  worker is doing without flooding the transcript.

### Changed

- **Subagent tool calls no longer spam chat history.** Tool telemetry is now a
  live status/fleet concern; the main chat keeps human-readable text and
  lifecycle summaries. Agent text streamed from FleetBus is debounced before it
  lands in history, while the live strip still updates quickly from deltas.

### Fixed

- **`grep` ripgrep backend correctness.** Regex syntax is validated before
  invoking `rg`, default ignored directories are excluded consistently in both
  native and `rg` backends, and `output_mode: "count"` now returns the total
  match count rather than the number of files with matches.
- **Full test suite regression.** `pnpm test` is back to green:
  2045 passing tests across 202 files, with 1 skipped.

## [0.2.0] — 2026-05-16

The "autonomous fleet" release. Six weeks of work focused on one
question: can a Director and its subagents run for hours without the
user babysitting them? The answer required a full pass over the
coordination layer — every race condition fixed, every silent failure
classified, every "what is the subagent doing right now?" question
answered with a visible chip in the TUI.

Headline changes:

- **`/goal`** and **`/steer`** — true autonomous mode (preamble locks
  the agent into a verifiable finish) and true mid-flight redirect
  (Esc captures snapshot, terminates fleet, sends rich STEERING
  context). The chat stays clean; the rich context goes to the model.
- **Unlimited budgets by default** — the 20-tool / 20-iteration cap on
  `/spawn` and the coordinator's `defaultBudget` are gone. The
  orchestrator decides, the Agent's `autoExtendLimit` is the runaway
  backstop. Pair with `--goal` for relentless one-line task launches.
- **SubagentError envelope (14 kinds)** — `TaskResult.error` is no
  longer an opaque string. Every failure is classified
  (`provider_5xx`, `provider_rate_limit`, `tool_failed`,
  `empty_response`, `aborted_by_parent`, …) with `retryable` +
  `backoffMs` so the calling LLM can branch instead of substring-
  matching error messages.
- **Coordinator race fixes** — duplicate-id spawn rejected,
  stop+assign race produces synthetic completion, `stopAll()` drains
  the pending queue, error-state reset is synchronous, tool counter
  pairs on `tool.executed`. Per-task `dispose` hook closes
  per-subagent JSONL writers so the FD leak at ~1000 tasks is gone.
- **Observability surface** — LiveActivityStrip above the input,
  `currentTool` on FleetEntry, `transcriptPath` on `subagent.spawned`,
  `provider.thinking_delta` forwarded to FleetBus, `/fleet log <id>`
  for summary / raw transcript dumps, Director shutdown errors via
  `process.emitWarning` instead of silent `.catch`.
- **Session checkpoint system** — `<id>.todos.json`, `<id>.plan.json`,
  and `<id>/director-state.json` sidecars turn `wstack resume <id>`
  into real continuation instead of replay. `/fleet retry [taskId]`
  resumes interrupted multi-agent runs.
- **`/plan` + `planTool`** — strategic roadmap parallel to todos,
  surfaced both as a slash command and an LLM-callable tool.
- **WebUI polish** — collapsible tool input/output, diff view,
  per-message cost attribution, concurrent-run lock, WS connect()
  rejects on error instead of hanging.
- **Test coverage 1981 / 195 files** — five new dedicated suites
  cover every failure mode that previously fell through the cracks.

No breaking changes. CLI flags, plugin API, system-prompt builder,
and EventBus contract are all backwards compatible. `--goal` /
`--ask` and `/goal` / `/steer` are additions; existing slash
commands and CLI flags work unchanged.

### Added

- **Session checkpoint system.** Three new sidecar files next to each
  session JSONL turn `wstack resume <id>` into a real "kaldığım yerden
  devam" experience instead of just replaying messages:
  - `<id>.todos.json` — `ctx.todos` mirrored to disk on every
    `todos_replaced` mutation (150ms debounce, atomic write). Reloaded
    transparently on resume; `attachTodosCheckpoint(state, path, id)`
    is the new public helper in `@wrongstack/core`.
  - `<id>.plan.json` — strategic roadmap maintained via the new
    `/plan` slash command (`show|add|start|done|remove|clear`). Plans
    are higher-level than todos (survive across sessions by intent)
    and surface a "N items, M open" banner on resume.
  - `<id>/director-state.json` — live director task graph
    (pending/running/completed + spawn roster + usage), written
    incrementally as spawns and task completions land. Distinct from
    the existing `fleet.json` manifest, which previously only got
    written on `Director.shutdown()` and is now also periodically
    flushed (~2s debounce) on every spawn/assign/complete event.

- **Director session event emission.** `Director` accepts an optional
  `sessionWriter` and now forwards `agent_spawned`, `task_created`,
  `task_completed`, and `task_failed` events to the host session JSONL
  — these were already in the `SessionEvent` union but were never
  actually emitted by any subsystem. Production callers (CLI) pass the
  same writer the host Agent uses so all events land in one log.

- **`/plan` slash command** for strategic roadmap management
  (`packages/cli/src/slash-commands/plan.ts`). Items have status
  (`open` / `in_progress` / `done`), optional details, and stable ids.

- **`planTool` — LLM-callable counterpart to `/plan`.** Registered with
  the builtin tool set; reads `ctx.meta['plan.path']` (seeded by the
  CLI during startup) so the model can manage long-running strategy
  the same way it manages todos. One tool, six actions
  (`show|add|start|done|remove|clear`).

- **`/fleet retry [taskId|all]`** for resuming interrupted multi-agent
  runs. Reads `director-state.json`, finds tasks left in `running` /
  `pending` state when the previous process died, and re-spawns the
  matching subagent (preferring the original roster role) before
  re-assigning the task. Auto-promotes to director mode if needed.

- **TUI plan chip** in the status bar (`📋 ⌛N ☐N ✓N`), polling
  `<sessionId>.plan.json` every 3s. Distinct from the todos chip so
  the user can read tactical and strategic progress at a glance.

- **`delegate` tool — autonomous multi-agent activation.** A new
  always-on built-in tool (`packages/core/src/coordination/delegate-tool.ts`)
  bundles spawn + assign + await into one call. Registered in every
  CLI session regardless of `--director` mode: the first call
  auto-promotes the host to director mode under the hood, so the
  model no longer needs the user to "enable multi-agent" before it
  can delegate. Accepts a roster role (`bug-hunter`, `security-scanner`,
  `refactor-planner`, `audit-log`) OR an explicit `name`/`provider`/`model`.
  Per-call `timeoutMs` cap (default 5min) keeps a hung worker from
  hanging the host turn.

- **System prompt "Delegation" section.** The
  `DefaultSystemPromptBuilder` now detects when the `delegate` tool is
  registered and injects a guide telling the model when to delegate
  (task fans out naturally, specialized role exists, subtask would
  blow up context) and when to stay in-process (trivial / atomic /
  user mid-conversation). The model can read the available role list
  off the tool's schema enum without any extra plumbing.

- **Plan-aware system prompt.** `DefaultSystemPromptBuilder` accepts
  `planPath?: string | (() => string | undefined)` and reads the
  session's `<id>.plan.json` on every `build()` call. Open items are
  injected as an ephemeral "Active plan" block so the LLM is anchored
  to the strategic roadmap every turn — not just on resume. The getter
  form lets DI containers bind the builder before the session id is
  known. CLI seeds the path automatically.

- **`/fleet log [<subagentId>] [raw]`** — surface per-subagent
  transcripts. Without arguments lists every JSONL on disk for the
  current session's fleet. With an id shows a compact summary
  (iteration count, tool breakdown, first task, last response, event
  mix). Append `raw` to dump the full JSONL when you need the
  uncompressed view.

- **`/goal <description>` — autonomous lock-in mode.** Slash command
  in the TUI that prepends a four-section preamble to the next agent
  turn (AUTHORITY / DONE / NOT DONE / PERSISTENCE), turning the leader
  into a relentless worker that drives the task to a verifiable
  finish. No implicit budget cap, full multi-provider fan-out
  permission, explicit anti-patterns ("should I continue?", "I
  believe this fixes it"), three-angle persistence rule for blockers.
  Only the user can stop a /goal — Esc / `/steer` redirect, Ctrl+C /
  `/fleet kill` bail out.

- **`--goal "<task>"` and `--ask "<text>"` boot flags.** Launch
  directly into goal mode (or pre-populated single-turn) from the
  shell, no need to type `/goal` after the TUI starts up. `--goal`
  auto-enables `--tui` since the goal-mode steering surface lives
  there. Pair with `--director` for one-line fleet kickoffs:
  `wstack --director --goal "audit packages/core for races"`.

- **`/steer <new direction>` and `Esc`-to-steer.** Mid-flight redirect
  primitives. Both abort the active iteration, terminate running
  subagents (1.5s cap), drop the queued messages, and send the new
  direction with a rich STEERING preamble prepended — snapshot of
  in-flight tools, terminated subagents (with their currentTool),
  last partial assistant text, plus explicit authority to abandon
  the prior plan. The chat just shows `↯ <text>`; the preamble goes
  to the model, not the human view. `/steer` works whether the agent
  is busy or idle; Esc only when the agent is busy.

- **`SubagentError` envelope — 14 classified failure kinds.**
  `TaskResult.error` is no longer an opaque `string`; it's a
  discriminated union with `kind`, `message`, `retryable`,
  optional `backoffMs`, and the original `cause`. Kinds:
  `provider_5xx`, `provider_rate_limit`, `provider_auth`,
  `provider_timeout`, `context_overflow`, `tool_failed`,
  `tool_threw`, `budget_iterations`, `budget_tool_calls`,
  `budget_tokens`, `budget_cost`, `budget_timeout`,
  `aborted_by_parent`, `empty_response`, `bridge_failed`,
  `unknown`. `classifySubagentError` is exported for tests and
  CLI surfaces. The delegate tool output exposes `errorKind` /
  `retryable` / `backoffMs` so the calling LLM can branch on
  classification. Chat renders `[kind]` chip beside every failed
  task. Backwards-compat string is preserved as
  `error.message`.

- **LiveActivityStrip above the input area.** Compact one-line-per-
  subagent strip that sits directly above the input, showing
  `● <name> · → <currentTool> (Xs) · Nit Mtc · elapsed`. Renders
  nothing when no subagents are running. Updates every tick so
  elapsed timers stay live. Works in both director and non-director
  mode.

- **Per-tool surface in chat regardless of director mode.** Every
  subagent's `tool.executed` event is now bridged from its per-task
  EventBus onto the host EventBus as `subagent.tool_executed`, and
  the TUI listens unconditionally — `[AGENT#1] ● bash 250ms · 1.2KB`
  lands in chat for plain `/spawn` too. Director-mode `/fleet stream
  on` still adds the richer verbose stream with arg formatting +
  currentTool live updates.

- **`subagent.tool_executed` event** on the host EventBus
  (`packages/core/src/kernel/events.ts`). Carries `subagentId`, tool
  name, duration, ok, optional input + outputBytes. Bridge installed
  by `MultiAgentHost.spawn` factory, cleaned up via the existing
  dispose hook.

- **`tool.progress` budget heartbeat.** The subagent runner subscribes
  to `tool.progress` events emitted by long-running tools (bash
  chunks, fetch byte progress, spawn-stream stdout) and calls
  `ctx.budget.checkTimeout()` on each heartbeat. A `bash sleep 3600`
  no longer parks past its wall-clock deadline waiting for the
  coordinator's hard `Promise.race` — the budget trips cooperatively,
  the aborter fires, signal propagates to the tool, child process
  killed. Tools without progress emission still rely on the
  coordinator race as the backstop.

- **Per-subagent JSONL path on `subagent.spawned`.** New
  `transcriptPath?: string` field carries the absolute path to the
  per-subagent transcript file. Pre-computed from the session
  factory dir at spawn time so the very first event the TUI sees
  already has it. `SessionWriter.transcriptPath` (readonly,
  optional) is the new contract; `FileSessionWriter` exposes it via
  a getter. The FleetPanel renders `log: <path>` under each entry
  so users can `tail -f` without grepping the filesystem.

- **`currentTool` on FleetEntry.** Tracks the tool a subagent is
  currently inside via `tool.started` (set) / `tool.executed`
  (clear). FleetPanel renders `→ bash (250ms)` under running
  subagents.

- **`provider.thinking_delta` forwarded onto FleetBus.** Subagents'
  extended-thinking output now surfaces to the FleetPanel and
  `/fleet log` instead of falling between `iteration.started` and
  the first text delta.

- **Coordinator race fixes.** `spawn()` rejects duplicate ids
  (previously silently overwrote, orphaning the prior subagent's
  AbortController + Context). `stop()` + `assign()` race produces a
  synthetic `aborted_by_parent` task.completed instead of an orphan
  task that leaked `inFlight` forever. `stopAll()` drains the
  pending queue with the same synthetic completion. Error-state
  reset is synchronous now (the prior `queueMicrotask` opened a
  window where `assign()` could observe a "running" worker that was
  actually idle). Tool counter pairs on `tool.executed` rather than
  `tool.started` — a tool that fires start then crashes mid-exec
  no longer drifts the budget tally.

- **Per-task `dispose` hook on `AgentFactoryResult`.** Closes the
  per-subagent JSONL writer in the runner's `finally` block —
  swallowed errors, so a flaky cleanup can't mask the real task
  result. Closes the FD leak that exhausted at ~1000 tasks.

- **Director listener leak fix.** `coordinator.on('task.completed',
  ...)` is now captured in a field and `off()`-ed in
  `Director.shutdown()`. Repeated Director construction (tests, hot
  reloads) no longer accumulates listeners.

- **`promoteToDirector` failure reason.** When promotion is refused
  because subagents are already running, the host records a
  human-readable reason ("Cannot promote: N subagents are running.
  /fleet kill them or wait.") and the delegate tool surfaces it
  verbatim to the calling LLM. Replaces the prior opaque "Director
  could not be activated" message.

- **Director shutdown errors surface via `process.emitWarning`.**
  Bridge.stop / writeManifest / stateCheckpoint.flush failures used
  to be silently swallowed with `.catch(() => undefined)`. They now
  funnel through `process.emitWarning('DirectorShutdownWarning',
  ...)` so hosts can plug a warning listener for structured
  collection; default stderr surface is enough to spot a persistent
  failure during normal use.

- **Ctrl+C terminates the fleet with a 1.5s ceiling.** The TUI's
  SIGINT handler now races `director.terminateAll()` against a
  1.5s cap before falling through to the exit ladder, so subagents
  drain cleanly when possible and hard-exit when wedged.

- **Test coverage: 1981 total.** Five new dedicated suites pin the
  regression duvarı:
  - `subagent-error-classification.test.ts` — 20 tests covering
    every kind + the integration path
  - `coordinator-race.test.ts` — duplicate-id reject (T5),
    stop+assign race (T4), stopAll drain (T4b), paired tool
    counter (T8), synchronous error-reset (M4)
  - `subagent-abort-during-tool.test.ts` — mid-tool abort (T3),
    stop-after-tool-completes
  - `subagent-budget-edges.test.ts` — `tool.progress` heartbeat
    busts mid-tool, no-timeout regression guard
  - `fleet-usage-aggregator.test.ts` — disjoint cost-bucket
    contract (M2), per-subagent isolation, missing price guard
  - `delegate-tool.test.ts` +2 — partial JSONL read robustness
    (T6) on missing + corrupt transcripts
  - `steering-preamble.test.ts` — 9 tests covering both
    `buildSteeringPreamble` and `buildGoalPreamble` structural
    guarantees

### Changed

- **Unlimited budgets by default.** The prior 20-tool / 20-iteration
  hardcap on `/spawn` adhoc subagents (`packages/cli/src/multi-agent.ts`)
  is gone, and the coordinator's `defaultBudget` (1000 tools /
  200 iter / 4h timeout) has been removed entirely. Subagents get
  a budget only when the orchestrator (`delegate` /
  `spawn_subagent`) explicitly passes one. Runaway protection now
  lives in the Agent's iteration loop (`autoExtendLimit: true`,
  auto-grants 100 more iterations every 100 forever). `maxConcurrent`
  raised 2 → 8. Director `maxSpawnDepth` 2 → 5 so recursive
  delegation works without tripping the depth budget at level 3.

- **Subagent tool-counter pairs on `tool.executed`.** Was previously
  incremented on `tool.started`, which produced phantom counts when
  a tool started then crashed before emitting executed. The paired
  count matches what the model actually saw in its turn.

- **Subagent `empty_response` is now a classified failure.** An LLM
  run that returns `status: 'done'` with empty `finalText` AND zero
  tool calls used to silently succeed; now surfaces as
  `kind: 'empty_response'`. Almost always indicates a prompt /
  config issue rather than legitimate "nothing to say".

- **Subagent `tool_failed` is now a classified failure.** A tool
  returning `ok: false` whose error the agent never recovered from
  (no follow-up text on the next iteration) used to report a clean
  success. Now surfaces as `kind: 'tool_failed'` with the failed
  tool name in the message. Healthy "tool errored then I tried
  again" patterns still report success because the next iteration's
  text clears `lastToolFailed`.

- **`SlashCommand.run` may return `{ runText }`.** Lets a slash
  command queue a follow-up user-role message that the TUI submits
  as if the user had typed it. Used by `/steer` and `/goal` to send
  the rich preamble. Backwards compatible — existing commands
  return `{ exit?, message? }` as before.

- **TUI alt-screen by default.** `runTui({ altScreen })` now defaults
  to `true`, taking over the alternate screen buffer (vim/less/htop
  style) so every keystroke — Ctrl+S, Ctrl+Q, Ctrl+Z, Ctrl+\\ — reaches
  Ink instead of being eaten by the terminal driver. `--no-alt-screen`
  is the new opt-out flag for users who want completed chat to survive
  after exit. `runTui` additionally installs no-op handlers for
  `SIGTSTP`/`SIGQUIT`/`SIGTTIN`/`SIGTTOU` as belt-and-suspenders.

### Fixed

- **TUI TDZ crash on first subagent spawn.** The `fleetAgents`
  `useMemo` (status bar 4th line) called `labelFor` in its
  callback, but `labelFor` was declared ~550 lines further down in
  `App`. While `state.fleet` stayed empty the memo's early-return
  skipped the call, so the temporal-dead-zone access stayed
  dormant — but the first `/spawn` populated `state.fleet` and the
  next render hit `Cannot access 'labelFor' before initialization`,
  killing the TUI mid-frame. Moved the `labelFor` + `labelsRef` +
  `STREAM_COLORS` block above `fleetAgents` so the const is
  initialised before any memo body runs.

- **Ctrl+C with a wedged delegate.** The first Ctrl+C only
  cancelled the host agent loop; a delegate that ignored the
  abort signal would keep the parent parked in `await
  director.awaitTasks` and the "press again to exit" hint became a
  lie. Ctrl+C now races `director.terminateAll()` against a 1.5s
  cap before unwinding so the fleet drains polite-first then
  hard-cuts.

- **`/spawn` artificial 20-tool / 20-iter caps killed real work.**
  Real screenshot from the field: `AGENT#1 ✗ failed (9 iter · 21
  tools · 248s) [budget_tool_calls] — Budget exceeded: tool_calls
  (limit=20, observed=21)`. The 20 was a defensive default from
  when `/spawn` was a single-shot tester; for an autonomous
  director that delegates and respawns it was crippling. Caps
  removed; orchestrator owns the budget decision.

- **Test pollution writing to project cwd `tmp/`.** A test in
  `packages/cli/tests/multi-agent.test.ts` was using a relative
  `'tmp/fleet/session-2'` path that materialized fleet JSONLs inside
  the project working directory. Switched to `os.tmpdir()` + cleanup.
  Production code already routed all fleet artifacts under
  `~/.wrongstack/projects/<hash>/sessions/<id>/`.

- **`replace` tool symlink hardening (round 2).** `safeResolve` could
  pass a symlink whose target lived outside the project root. Added
  `lstat` + `isSymbolicLink` checks and a `realpath` cross-validation
  against the project root before the atomic write, plus a hard skip
  for any file resolved outside the root. Complements the earlier
  0.1.10 symlink/TOCTOU fix.

- **WebUI ws-client connect() hangs on failure.** The connect promise
  used to wait forever when the WebSocket emitted `onerror` / `onclose`
  before `onopen`; UI callers blocked indefinitely with no surfaced
  error. Promise now rejects on those paths so the UI can render the
  failure.

- **WebUI concurrent `agent.run` race.** `server/index.ts` had no
  guard against a second message arriving while the first was still
  streaming; the second `agent.run` would interleave with the first
  and corrupt session state. Added a `runLock` guard that queues or
  rejects (depending on config) concurrent runs.

- **WebUI tool/message rendering.** `MessageBubble` now renders
  collapsible tool input (shallow params as key/value table, nested
  as expandable JSON) and tool output (with copy / download / error
  stack toggle / raw markdown toggle). Per-message
  iterations/tools/elapsed/$ footer; multi-tool turns grouped under
  a single bubble.

## [0.1.10] — 2026-05-15

Core package restructuring + thinking/reasoning stream support + tool
output size chips + child-process env hardening pass + WebUI guard and
formatting sweep. No breaking changes — additive on the plugin contract
(`KERNEL_API_VERSION` moves to `0.1.10`; `apiVersion: "^0.1"` plugins
keep loading).

### Added

- **`@wrongstack/core` subpath exports reorganized.** `execution/`,
  `coordination/`, `infrastructure/`, `storage/`, `security/`,
  `models/`, `sdd/`, and `observability/` are now independent subpath
  entrypoints — `import { Agent } from '@wrongstack/core'` works as
  before, but consumers can now deep-import `@wrongstack/core/execution`,
  `@wrongstack/core/coordination`, etc. The old `defaults/` barrel is
  deprecated but preserved as a re-export. 8 new `exports` maps
  added to `package.json`; `tsup` config updated to emit each
  entrypoint. No runtime change for existing consumers.

- **Extended thinking / reasoning stream support.** Six new stream
  events wired end-to-end — `thinking_start`, `thinking_delta`,
  `thinking_signature`, `thinking_stop` — with full `StreamingState`
  tracking, `buildResponse()` content-block ordering, and an empty-block
  guard that prevents `400` on Anthropic. `content_block_start` now
  recognizes `kind: 'thinking'`. The agent loop emits
  `provider.thinking_delta` events; the WebUI server broadcasts them
  for a transient "Thinking…" chip; the CLI + TUI forward
  `thinking_delta` through the WebSocket. Providers (Anthropic, OpenAI,
  Google) that already annotate thinking deltas are plumbed; OpenAI
  `reasoning_content` in `chunk.choices[0].delta` is normalized to
  `thinking_delta`.

- **Tool output size chips on `tool.executed`.** The agent loop now
  computes `outputBytes` (UTF-8 byte length), `outputTokens`
  (~3.5 chars/token heuristic), and `outputLines` (read-prefix counts
  or newline-based for bash/grep/logs) before emitting
  `tool.executed`. These ride as optional fields on the existing
  event — the TUI renders them as inline chips beside tool results
  (`1.2 KB · ~340t · 45 lines`). The `output` field remains the
  400-char preview; the chip fields reflect the full uncapped result.

- **`buildChildEnv()` centralized in `@wrongstack/core`**
  (`@wrongstack/core/utils`). Previously duplicated across
  `tools/src/_env.ts`, `tools/src/bash.ts`, and `tools/src/exec.ts`.
  Now a single canonical implementation with an explicit allowlist
  (PATH, HOME, LANG, …), secret-name detection (TOKEN, SECRET, API_KEY,
  …), and a tooling-prefix pass (NODE_, NPM_, PNPM_, YARN_, GIT_,
  CI, XDG_…). The `_spawn-stream` helper and `patch` tool also use
  it. Override with `WRONGSTACK_CHILD_ENV_PASSTHROUGH=1` (the legacy
  `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` is preserved as an alias).

### Fixed — security

- **`patch` tool child-process env hardened.** `runPatch()` previously
  passed `{ ...process.env }` as the env — API keys and tokens leaked
  into the `patch` subprocess. Now uses `buildChildEnv()` with
  `LANG=C / LC_ALL=C` overrides layered on top. The `patch` call
  site was the last `process.env` spread remaining in the tools layer.

- **`replace` tool symlink traversal.** The native glob walk
  (`globNative`) now skips symlinks with `e.isSymbolicLink()` rather
  than following them, matching the `grep` tool's behavior from 0.1.6.

- **MCP `SSEReader` buffer cap (256 KB).** Defense-in-depth: the
  SSE reader inside MCP HTTP transports now throws if the pending-line
  buffer exceeds 256 KB, preventing a malicious stream from pinning
  memory. The upstream providers SSE parser already enforces this cap;
  this covers the MCP transport's own reader.

- **WebUI overlapping-run guard.** `handleUserMessage` previously
  aborted the prior run and started a new one — a second
  `agent.run()` could sneak in before the first's cleanup settled,
  corrupting context state. Now rejects with an error message if a
  run is already in flight. The abort path remains reachable through
  explicit `abort` messages from the client.

- **WebUI `broadcast()` error handling.** A client disconnecting
  between the `readyState` check and the `send()` call previously
  propagated as an unhandled rejection. Now caught and silently
  dropped — the `close` handler removes the client naturally.

- **Memory-store consolidation backup.** `consolidate()` now writes
  a `<file>.bak.<ts>` backup before the atomic write so a crash
  mid-consolidation doesn't lose the pre-consolidation state.

### Changed — core

- **Usage type disjoint-semantics documented.** `Usage.input` is now
  formally specified as the FRESH input token count (excluding cached
  portions). Provider adapters (Anthropic, OpenAI, Google) already
  normalize to this invariant; the JSDoc on the type now states it
  explicitly so third-party providers don't double-count cache.

- **Prometheus `startMetricsServer` gains health endpoint.** A
  `healthRegistry` option enables `/healthz` alongside `/metrics` on
  the same port — K8s probes expect a single HTTP server; no need
  for a sibling listener. The `/healthz` handler returns JSON
  aggregate with status codes (200 healthy, 503 unhealthy).

- **WebUI WebSocket binds to `127.0.0.1` explicitly.** Previously
  `new WebSocketServer({ port })` defaulted to `::` on dual-stack
  systems, risking LAN exposure. Now binds `127.0.0.1` — existing
  `WS_HOST` env override still works for network scraping.

### Internal

- **`provider-config-utils.ts` extracted** from `webui-server.ts` —
  `normalizeKeys`, `writeKeysBack`, `maskedKey`, and `nowIso` are
  now reusable by the CLI subcommands layer.
- **Source files alphabetized** — import ordering, `package.json`
  `keywords`/`scripts` arrays, and test-import blocks across
  `packages/core`, `packages/cli`, `packages/mcp`,
  `packages/providers`, `packages/tools`, `packages/plug-lsp`,
  `packages/tui`, and `packages/webui`.
- **WebUI server source reformatted** — long lines broken at ~100
  columns, trailing commas added consistently, brace style normalized
  to match the rest of the codebase.

## [0.1.9] — 2026-05-15

Post-0.1.7 audit triage + Director orchestration ecosystem + `/fleet`
slash hub + `--director` CLI flag with full tool wiring + shared
fleet scratchpad + per-subagent JSONLs + Phase 6 safety caps. No
breaking changes — additive on both the public API and the plugin
contract (`KERNEL_API_VERSION` moves to `0.1.9` to advertise the
new exports; `apiVersion: "^0.1"` plugins keep loading). The
preceding `v0.1.8` tag was a local-only snapshot that never shipped;
this is the first release to actually go out.

### Fixed — audit triage (bugs.md round)

- **`AutonomousRunner.toolCalls` now counts `tool.executed` events**
  rather than `agent.run()` calls. Previously a `maxToolCalls: 3` budget
  could let an iteration burst fire 15 tools before the done-condition
  tripped (counter only incremented once per iteration, not once per
  tool). The runner now subscribes to `agent.events.on('tool.executed')`
  for the lifetime of `run()`, tears the listener down in `finally`,
  and tolerates mock agents whose events bus is null/undefined.
  Regression test asserts a 5-tool burst trips a 3-tool budget after a
  single iteration.
- **MCP `_toolsCache` now stays in sync with `_tools`** on SSE/HTTP
  transport `onToolsChanged` callbacks. Previously only `_tools` was
  updated, so an empty tools-update would leave the cache pointing at
  the prior non-empty list and `MCPClient.listTools()`'s empty-`_tools`
  fallback would serve stale entries. Both stdio paths were already
  correct; this fix is scoped to the two remote transports.
- **`tool_use` meta-tool no longer hard-rejects confirm-permission
  inner tools.** The outer `tool_use` itself has `permission: 'confirm'`,
  so the user has already approved the call (and seen the inner tool
  name + input) by the time `execute()` runs — the duplicate inner
  check made every confirm-gated tool unreachable through `tool_use`.
  The inner `deny` check is preserved as a hard policy floor that
  meta-tools cannot bypass. `batch_tool_use` already followed this
  model.
- **`scaffold` migrated from sync to async I/O.** `fsSync.mkdirSync` /
  `fsSync.writeFileSync` in the template-write loop blocked the event
  loop for every file in a multi-file template. Switched to the
  already-imported `node:fs/promises` API; `handleBuiltIn` is now
  `async` and each `mkdir` / `writeFile` is awaited.

The remaining audit findings (BUG-002, -004, -005, -006, -007, -008, -009,
-010) were investigated and either intentional-by-design or
self-corrected in the report; see `bugs.md` for the per-finding triage.

### Added — Director orchestration

A new high-level orchestration surface that runs every subagent with its
own provider, model, context, session, and budget under an LLM-driven
**Director** that plans, spawns, asks, rolls up, and supervises the
fleet. Builds on the existing `MultiAgentCoordinator` + `SubagentBudget`
without breaking either — `MultiAgentHost`'s legacy path is unchanged,
director mode is opt-in via `--director`.

Design doc: [`docs/director-architecture.md`](docs/director-architecture.md).

- **`Director`** — owns a `MultiAgentCoordinator`, a `FleetBus`, a
  `FleetUsageAggregator`, and an in-memory `AgentBridge` so the director
  can `ask()` subagents synchronously. Public API: `spawn`,
  `assign`, `awaitTasks`, `ask`, `rollUp`, `terminate`, `terminateAll`,
  `status`, `snapshot`, `writeManifest`, `shutdown`, plus the
  `leaderSystemPrompt()` / `subagentSystemPrompt(config, taskBrief?)`
  composers for prompt injection. Lifecycle events are observable via
  `Director.on('task.completed', handler)` and the completed results
  cache via `Director.completedResults()`.
- **8 LLM-callable orchestration tools** via `Director.tools(roster?)`:
  `spawn_subagent`, `assign_task`, `await_tasks`, `ask_subagent`,
  `roll_up`, `terminate_subagent`, `fleet_status`, `fleet_usage`. Each
  ships a minimal JSON schema and `permission: 'auto'` (the user
  already approved the director run; gating each orchestration call
  would be noise — subagent tools are still permission-checked
  normally).
- **`FleetBus`** — fan-in for per-subagent `EventBus`es. Subscribe by
  subagent id (`subscribe(id, handler)`), by event type
  (`filter(type, handler)`), or to every event (`onAny(handler)`).
  Attach a subagent's bus with `attach(subagentId, bus, taskId?)`;
  detach with `detach(subagentId)`. Backed by canonical event names —
  `tool.started`, `tool.executed`, `tool.progress`, `tool.confirm_needed`,
  `iteration.started`, `iteration.completed`, `provider.text_delta`,
  `provider.response`, `provider.retry`, `provider.error`,
  `session.started`, `session.ended`, `token.threshold`.
- **`FleetUsageAggregator`** — subscribes to `FleetBus` and rolls up
  token/cost totals per subagent. Pluggable price lookup via
  `priceLookup(subagentId)`; output rows tag each subagent with the
  provider/model captured at spawn time. `snapshot()` returns
  `{ total, perSubagent: Record<id, SubagentUsageSnapshot> }`.
- **`makeDirectorSessionFactory({ store?, sessionsRoot?, directorRunId? })`**
  — produces a `SessionFactory` for the coordinator's per-subagent
  JSONL writers. Sessions land under `<sessionsRoot>/<runId>/<subagentId>.jsonl`
  so every subagent has its own replayable transcript — fleet replay
  doesn't need to demux a merged log.

**System-prompt injection for Director + subagents.** Two pure
composers — `composeDirectorPrompt()` and `composeSubagentPrompt()` —
plus a `rosterSummaryFromConfigs()` helper, all exported from
`@wrongstack/core`. The director-agent prompt is layered as
*fleet preamble → roster summary → user base prompt*; subagent prompts
layer as *bridge-contract baseline → role → task brief → per-spawn
`systemPromptOverride`*, with the override always last so it wins on
conflict. Two built-in defaults ship: `DEFAULT_DIRECTOR_PREAMBLE`
teaches the leader the eight fleet tools and working rules;
`DEFAULT_SUBAGENT_BASELINE` explains the bridge contract and the rule
that subagents may not exfiltrate the parent's system prompt or tool
list. Both overridable via `DirectorOptions.directorPreamble` /
`subagentBaseline`. `Director.leaderSystemPrompt()` and
`Director.subagentSystemPrompt(config, taskBrief?)` expose the
composed strings without mutating the config — factories opt in by
calling them when building each Agent.

### Added — CLI surfaces

- **`--director` flag.** Pass it to upgrade the lazy `MultiAgentHost`
  from the plain coordinator path to a `Director`-backed one. Same
  external `/spawn` / `/agents` / `/fleet` surface; under the hood,
  the host's task lifecycle now flows through `Director.spawn` /
  `Director.assign` so the in-memory manifest entries get populated.
  On boot, the host *eagerly* builds the Director and registers
  `director.tools(FLEET_ROSTER)` into the leader's `ToolRegistry` —
  the 8 LLM-callable orchestration tools (`spawn_subagent`,
  `assign_task`, `await_tasks`, `ask_subagent`, `roll_up`,
  `terminate_subagent`, `fleet_status`, `fleet_usage`) are visible to
  the leader from the first message, so a prompt like "spawn a
  bug-hunter and a security-scanner in parallel, then roll up their
  findings" actually orchestrates rather than narrating. `FLEET_ROSTER`
  (4 pre-built agents: Audit Log, Bug Hunter, Refactor Planner,
  Security Scanner) is automatically attached as the roster so
  `spawn_subagent({ role: "bug-hunter" })` works out of the box.
  Director artifacts share one root —
  `<projectSessions>/<sessionId>/`:
  - `fleet.json` (manifest)
  - `shared/` (fleet-wide scratchpad — see below)
  - `subagents/<name>.jsonl` (per-subagent transcripts)
  `MultiAgentHost` gains `ensureDirector()`, `manifest()`,
  `isDirectorMode()` for surface code; new options:
  `sharedScratchpadPath`, `sessionsRoot`, `directorRunId`.
- **Shared scratchpad for the fleet.** When `--director` is on, every
  subagent's system prompt automatically carries a "Shared notes"
  block pointing at `<fleetRoot>/shared/`. Agents drop conclusions
  into stable filenames (`findings.md`, `security.md`, etc.) and read
  sibling files before starting their own work — cheap
  filesystem-mediated coordination without going through the bridge
  for every paste. `Director.sharedScratchpadPath` is a readonly
  getter that surfaces the path; `composeSubagentPrompt` gains a
  `sharedScratchpad` part layered between Task and Override.
- **Per-subagent JSONL transcripts.** In director mode, each
  spawned subagent gets its own JSONL writer under
  `<fleetRoot>/subagents/<name>.jsonl` (instead of multiplexing into
  the parent session). Backed by `makeDirectorSessionFactory`, which
  is now wired into `MultiAgentHost`. Replay-friendly: each
  transcript is independently consumable.
- **`/spawn` flag parser.** Now accepts `--provider=<id>` /
  `--model=<id>` / `--name="..."` / `--tools=a,b,c` plus short forms
  `-p` / `-m` / `-n`. Quoted multi-word names supported via
  `--name="..."`. Single-arg legacy `/spawn <description>` preserved.
  Spawn confirmation message tags the subagent with its
  provider/model for visibility.
- **`/fleet` slash command hub.** Inspects and controls the subagent
  fleet without leaving the REPL: `/fleet` (defaults to status),
  `/fleet status`, `/fleet usage`, `/fleet kill <id>`, `/fleet
  manifest`, `/fleet help`. Status shows pending and completed tasks
  per subagent; usage rolls up iterations, tool calls, and durations
  across all completed tasks (sorted slowest first); kill sends a
  stop signal to a specific subagent; manifest is fully wired when
  running with `--director`. Wired through a new `onFleet` callback
  on `SlashCommandContext`.

**Tests** — 75 new tests across 5 files, all green:

- Core: 22 director tests (17 prior + 5 safety: maxSpawns rejects
  N+1, maxSpawnDepth rejects too-deep, defaults sane, spawn_subagent
  tool returns structured budget error, sibling/parent isolation
  regression) + 27 director-prompts tests (now including
  shared-scratchpad layering and `Director.sharedScratchpadPath`
  getter for set/null cases).
- CLI: 2 multi-agent provider-routing tests + 8 director-mode tests
  (isDirectorMode flips after lazy build, manifest null off-mode,
  manifest written on-disk in director mode, status/usage API
  stable in director mode, `ensureDirector()` returns null without
  the flag, `ensureDirector()` exposes the 8 orchestration tools,
  per-subagent JSONL writer is used when sessionsRoot is set,
  scratchpad path threads through to Director and into composed
  prompts) + 5 slash-command tests for `/spawn` + 7 `/fleet` tests.

### Added — safety caps (Phase 6)

- **`DirectorOptions.maxSpawns`** — lifetime cap on `Director.spawn()`
  calls. Default: `Infinity` (off). The N+1-th spawn rejects with a
  new `DirectorBudgetError`, status `subagents` reflect only the
  spawns that actually landed, no partial manifest entries are
  written. Use this to stop a runaway leader from billing tokens
  forever.
- **`DirectorOptions.maxSpawnDepth` + `spawnDepth`** — bounds the
  nesting of director-of-director chains. The root director sits at
  `spawnDepth: 0` (default); a sub-director constructed by a worker
  should pass `spawnDepth: parent.spawnDepth + 1`. When
  `spawnDepth >= maxSpawnDepth` (default `2`), `spawn()` refuses.
  This stops a hostile or confused prompt from constructing an
  infinitely-deep director chain.
- **`DirectorBudgetError`** — new typed error class with
  `kind: 'max_spawns' | 'max_spawn_depth'`, `limit`, `observed`.
  Exported from `@wrongstack/core`. The `spawn_subagent` tool catches
  this case and returns a structured `{ error, kind, limit, observed }`
  payload so the leader model can read the cap and replan instead of
  the tool call tearing down.
- **Isolation regression test pinned.** Verifies that
  `Director.subagentSystemPrompt(A)` and `subagentSystemPrompt(B)`
  never share content — neither sibling roles, sibling overrides, nor
  the director's own leader preamble leak into a subagent's prompt.
  Guards against a future composer change that accidentally smuggles
  parent or sibling context into the subagent layer.

### Changed — plugin API

- **`KERNEL_API_VERSION` advanced to `0.1.9`** (was `0.1.1`) to
  advertise the new additive surfaces above (Director, FleetBus,
  prompt composers, `DirectorBudgetError`, `FLEET_ROSTER`). Plugins
  pinning `apiVersion: "^0.1"` continue to load unchanged.
- **`@wrongstack/core/package.json` `wrongstackApiVersion`** updated
  to `0.1.9` in lockstep. `wstack version` and `wstack diag` now
  surface this value.

**Not yet shipped** (documented in `director-architecture.md`):

- TUI/WebUI fleet panels (subscribe to `FleetBus.onAny` for live view)
- `wstack replay <runId>` subcommand (rehydrate from `fleet.json`
  manifest)
- Bridge-level exfil enforcement (currently the subagent baseline
  prompt forbids requesting parent state, but the transport itself
  doesn't reject such requests — the leader/director is responsible
  for ignoring them when they arrive)

The core protocol and isolation invariants are proven; surface work
above can land independently without touching the core layer.

## [0.1.7] — 2026-05-15

WebUI polish + publishing pass. `@wrongstack/webui` debuts on npm; all
other packages re-publish in lockstep. No breaking changes.

### Added — `@wrongstack/webui` (first npm release)

- **Standalone WebUI is now publishable.** `dist/server/entry.js` ships
  with a `#!/usr/bin/env node` shebang so `npx @wrongstack/webui` works
  after install. `files: ["dist", "README.md", "LICENSE"]` keeps the
  tarball lean — no source bleed.
- **Vim-style chat navigation** — `j` / `k` step between message bubbles,
  `g` / `Shift+G` jump to first / last, `c` copies the focused bubble's
  text, `Esc` clears focus. Only active when not typing in an input.
  Documented in the `?` shortcuts overlay.
- **In-text search highlighting via CSS Custom Highlights API.** Ctrl+F
  now paints every match of the query with a soft yellow background;
  the active hit gets a stronger amber. No DOM mutation, plays cleanly
  with ReactMarkdown re-renders. Silent no-op fallback on browsers
  without the API.
- **Inline error stack-trace expander.** Assistant `isError` bodies
  detect V8 / Python / Java stack frames and collapse them behind a
  "Show stack trace (N frames)" toggle. The lead message stays visible.
- **Token estimate + context-budget chip in the input.** Past ~400 chars,
  the character counter grows a `≈Nt` token estimate (4-char heuristic).
  Tints amber when projected `lastInput + draft + 64` ≥ 85% of context
  window, red at 100%. Hover reveals the exact projection.
- **Drag-and-drop file attach.** Drag files from the OS onto the chat
  input → tokens are inserted as `@<basename>` and the FilePicker opens
  pre-seeded with the last dropped basename for workspace-path
  resolution. Multi-file supported; non-file drags ignored.
- **Pretty tool-input renderer** — `ToolInputView` replaces the raw JSON
  dump for non-diff tools with a key:value list; nested values are
  expandable rows with collapsed `[N items]` / `{N keys}` summaries.
- **Preferences sub-section in Settings → Appearance.** Toggle compact
  density and "Sound on completion" (Web Audio synthesized chime,
  plays only when the tab is hidden, gated by user preference).

### Fixed — `@wrongstack/webui` typecheck

- **`WSClientMessage` union** now includes `modes.list`, `mode.switch`,
  `files.list`, `todos.get`, `todos.clear` — handlers existed in
  `ws-client.ts` but lacked type declarations, so `send()` rejected
  them at compile time.
- **`WSServerMessage` union** now includes `WSFilesList`,
  `WSTodosUpdated`, `WSModesList`. The `.on()` consumers were casting
  payloads against shapes not in the union, which produced
  non-overlapping-cast errors.
- **`Sidebar.groupedHistory`** IIFE return type missed the `star?: boolean`
  field that the Favorites group literal already used.

### Added — release tooling

- **`scripts/bump-version.mjs`** — lockstep version bumper. Computes the
  next version from the highest seen across the workspace, writes the
  same value into all 10 package.json files (root, every `packages/*`,
  and `apps/wrongstack`). Leaves `workspace:*` cross-deps untouched —
  pnpm rewrites them at publish time.
- **Root scripts** — `pnpm version:patch|minor|major|set`,
  `pnpm release:check` (typecheck + test + build),
  `pnpm release:dry` (full dry-run), `pnpm release` (gate + publish).
- **`publishConfig.access: "public"`** added to every publishable
  package so `pnpm publish` no longer needs the `--access public` flag.

## [0.1.6] — 2026-05-14

Security hardening pass: 7 CRITICAL, 16 HIGH, 20 MEDIUM, 9 LOW findings from
a forensic codebase review closed out. **No public API breaking changes.**

The full threat model and rationale for each control is documented in
[SECURITY.md](SECURITY.md). Highlights below; if you only read one line,
read this one: **the `bash` tool now sanitizes its child process env so
`ANTHROPIC_API_KEY` / `GITHUB_TOKEN` / etc. are no longer forwarded to
LLM-generated commands.** Set `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` if you
need the prior behavior.

### Fixed — SSRF cluster (`fetch` tool)

- **Redirect target re-validated every hop.** A public host's 302 to AWS/GCE
  metadata (`169.254.169.254`) is now refused at hop 2; previously only the
  initial URL was checked.
- **Private-range detection rewritten with numeric CIDR.** Previously regex
  substring matching on hostname strings — bypassed by IPv4-mapped IPv6,
  CGNAT (100.64/10), multicast (224/4), reserved (240/4), Azure-style
  fd-prefixed ULA, and several other forms. New implementation fully
  expands IPv6 to 8 groups and compares numerically.
- **IPv4-mapped IPv6 in Node's URL-normalized form.** `https://[::ffff:127.0.0.1]/`
  becomes `[::ffff:7f00:1]` after `new URL().hostname` — the old detector
  missed this entirely. New detector decodes the v4-mapped low 32 bits
  back to an IPv4 address and runs the IPv4 private check.
- **DNS lookup before connect.** Best-effort guard against DNS rebinding;
  not a full guarantee (see SECURITY.md).

### Fixed — agent-tool boundary

- **`bash` child env sanitized** by an allowlist (PATH, HOME, LANG, …) plus
  substring-strip of TOKEN/SECRET/PASSWORD/AUTH/BEARER/COOKIE/PRIVATE/KEY
  variables. Opt-out via `WRONGSTACK_BASH_ENV_PASSTHROUGH=1`.
- **`bash` POSIX process-group kill** on timeout/abort — runaway grandchildren
  (`sleep 9999 & disown`) no longer survive.
- **`exec.allow_unknown` removed.** The flag advertised "DANGEROUS" was
  trivially flippable by an LLM; for unrestricted commands use `bash`
  (which is more clearly gated).
- **`exec` dead-code blocklist removed.** `FORBIDDEN_PATTERNS` only tested
  the command name, never the args — it never matched anything. The
  allowlist alone now does the gating.
- **`exec.cwd` validated** to resolve inside `ctx.projectRoot`.
- **`git.args` raw string field removed.** The bypass allowed
  `-c core.sshCommand=…` / `--upload-pack='sh …'` RCE. All git operations
  go through the typed subcommand fields.
- **`git.findGitDir` bounded by `projectRoot`** — non-git projects no
  longer drift into a parent repo at `~/repos/.git`.
- **`patch` diff-target validation.** `+++ ../../../etc/passwd`-style
  escapes are pre-rejected before GNU patch sees the diff. `strip` clamped
  to ≥1. Temp diff file written into a `0700 mkdtemp` directory rather
  than a predictable timestamp name. `LC_ALL=C` set so the
  "patching file" detection works under any locale.
- **`replace` symlink/TOCTOU.** Resolves through `realpath`, validates
  the result is inside `projectRoot`, writes to the resolved path.
  Symlinks are skipped, not followed.
- **`grep` symlinks skipped** during native traversal.
- **User-regex ReDoS guard** (`compileUserRegex` in `packages/tools/src/_regex.ts`)
  — 512-char pattern cap, rejection of `(a+)+`-style nested quantifiers,
  64 KB subject-line cap. Applied to grep, replace, logs.
- **`grep` stdout buffer 1 MB cap** — pathological producers (matching a
  huge binary with no newlines) can't pin memory.
- **`logs.lines:0`** historically buffered the entire file; now clamps to
  100k lines via a fixed-size rolling window.

### Fixed — MCP / multi-agent lifecycle

- **MCP `failPending()` on transport death.** When a stdio child exits or
  `close()` is called, every in-flight JSON-RPC request is rejected with a
  transport-closed error. Previously callers (e.g. `callTool` mid-tool-use)
  hung forever on a dead transport.
- **MCP SIGTERM → SIGKILL escalation.** Stuck servers that ignored
  SIGTERM stayed alive after `close()` returned. Now waits 800ms then
  force-kills.
- **MCP registry disconnect-listener leak fixed.** Listeners were stored
  in a Set keyed by arrow-function reference; remove never matched because
  each call site created a fresh lambda. Now stored on the slot.
- **MCP registry closes prior client** before swapping references on
  reconnect.
- **`Multi-agent` floating promise + inFlight leak fixed.**
  `runDispatched` no longer bumps `inFlight` when no runner is wired (it
  would never be decremented). Sync errors in dispatch now produce a
  failed task instead of an unhandled rejection.
- **`Multi-agent` AbortController recycle** after timeout, so the next
  task on the same subagent doesn't start with an already-aborted signal.
- **`agent-bridge` duplicate correlation-id detection.** Caller-supplied
  message IDs that collide with in-flight requests now throw at submit
  time instead of silently replacing the prior pending entry.
- **`tool-executor` per-tool error isolation.** A `safeRun` wrapper
  ensures one tool's unexpected exception doesn't collapse `Promise.all`
  and lose every sibling's output.

### Fixed — providers / SSE

- **Provider tool-call argument validation.** All six stream parsers
  (Anthropic, OpenAI, Google, Mistral preset, plus the aggregate path)
  route arg JSON through a shared `parseToolInput` helper. Arrays, null,
  scalars, and invalid JSON are wrapped under `__raw` so the tool always
  receives a `Record<string, unknown>`.
- **SSE parser buffer cap (256 KB)** + incremental CRLF normalization.
  Previously `buffer.replace(/\r\n/g, '\n')` ran on the entire pending
  buffer per chunk — O(n²) in stream length.
- **Stream builder no longer fabricates `stopReason: 'max_tokens'`** on
  abort. Uses `'end_turn'` instead so telemetry isn't poisoned and retry
  logic that branches on max_tokens doesn't trigger.

### Fixed — type safety / config

- **Config-loader `apiKeys` entries filtered** through a runtime type
  guard before use — a null or malformed entry no longer crashes provider
  resolution.
- **Config-loader JSON parse vs ENOENT** distinguished: a typo'd local
  config now warns instead of silently falling back to defaults.
- **Config `context.*` thresholds typeof-checked** — string values in
  `config.json` no longer coerce silently through `>=`.
- **Prototype pollution guard** on `deepMerge` (config-loader,
  secret-vault) — `__proto__` / `constructor` / `prototype` keys ignored.
- **SecretVault per-field decrypt try/catch** — one corrupted ciphertext
  no longer kills the entire config load.
- **Session-store JSONL shape validation** — events with malformed
  `type` / `ts` are skipped at load rather than crashing replay.
- **Session-store error wrapping** uses `Error.cause` to preserve
  ENOENT/EACCES/EMFILE codes.
- **`SubagentContext.parentBridge` typed `| null`** — the previous
  `null as unknown as AgentBridge` cast was a type lie that hid the
  two-phase init contract.
- **`SessionAnalyzer.analyze` populates `sessionId`, `tasks`, and
  `modeChanges`** from session_start/task_*/mode_changed events; these
  were hardcoded empty.

### Added

- **`Tool.subjectKey`** — Tools can declare which input field is the
  permission-trust subject. Bash → `command`, fetch → `url`. Without this
  the policy heuristic could mismatch across tools (an HTTP tool whose
  `path` means request-path would have been checked against filesystem
  trust rules). Optional; legacy heuristic still applies as fallback.
- **[SECURITY.md](SECURITY.md)** — Threat model, adversary assumptions,
  every control with rationale, and known limitations.

### Internal

- 57 new tests covering env stripping, regex compilation, tool-input
  validation, and 28 SSRF cases (private-range detection, redirect
  re-validation, IPv6 v4-mapped, public-IP sanity).
- TypeScript and tsup versions aligned across all packages
  (was: root 5.9.3 + 8.5.1, packages 5.7.2 + 8.3.5).
- MCP `clientInfo.version` bumped to `0.1.6`.

### Follow-up hardening (post-initial 0.1.6 audit pass)

- **`system-prompt-builder.gitStatus` bounded at 2 s.** A hung `git status`
  (corrupt index, `.git/index.lock` held by another process, slow network
  FS) previously stalled the entire prompt build per turn. Times out
  gracefully to `git timeout`.
- **`system-prompt-builder.detectLanguages` parallelized.** 11 marker
  probes were sequential; now fanned out via `Promise.all`.
- **`system-prompt-builder.envCache` keyed by `projectRoot`.** Reusing a
  builder across different project roots used to serve the first call's
  cached env block to later calls.
- **Mode + capabilities resolution moved to builder construction-time
  options.** `BuildContext.activeModeId` / `BuildContext.capabilities`
  were dead surface (no caller ever set them on ctx). Now passed via
  `DefaultSystemPromptBuilderOptions.modeId` / `modePrompt` /
  `modelCapabilities`, and the CLI resolves them once at startup.
- **Skill block moved into env layer.** Skills are static per session,
  so they now ride the cached env block instead of being rebuilt per
  turn in layer 4.
- **`session-store` append-failure warnings debounced** to one log per
  5 s with a `+N suppressed` tail. A chatty agent against a full disk
  previously logged on every event.
- **`mcp/client.connectStdio` resets `rxBuffer`** at the top of every
  connect to prevent stale bytes from a half-initialized prior attempt
  on the same instance corrupting JSON-RPC parsing on the new stream.
- **`tools/edit` stale-read mtime tolerance raised to 2000 ms on
  Windows.** FAT and some network filesystems quantize mtime to 2 s,
  so the previous 1 ms tolerance threw false "modified externally"
  errors after a tool's own write→read cycle.
- **`WstackPaths.configDir`** alias for `globalRoot` — gives callers a
  semantic name for user-global stateful config and lets us split out
  `XDG_CONFIG_HOME` later without rewriting consumers. `TOKENS.ModeStore`
  registered so DI consumers can resolve it.

### Bugs.md triage round — 6 closed, 4 false-positive, 3 by-design

- **`memory-store.remember()` race fixed** — concurrent remember/forget/
  consolidate/clear calls were lost because of unlocked read-modify-write.
  Added per-scope async chain so writes serialize per scope while
  different scopes still run in parallel.
- **`estimateToolInputTokens` no longer mutates caller's input** — the
  per-input cache used to attach `__tokenEstimate` to the input object,
  which threw on `Object.freeze`'d inputs. Moved to a module-level
  `WeakMap<object, number>`.
- **`parseProviderHttpError` surfaces truncation** — raw HTTP error
  bodies over 2 KB were silently truncated. `ProviderErrorBody` gains
  `truncated: boolean` and `rawLength: number`.
- **`OpenAICompatibleProvider` quirks redundancy** — explicit `...?.x`
  reassignments after the spread copied the same values; collapsed to
  the spread alone.
- **Coordinator `inFlight_underflow` warning de-noised** — only fires
  when a runner is wired (true double-completion), not on every legit
  no-runner-pattern completion.
- **`compaction.failed` event** — auto-compaction errors were swallowed
  silently by design (don't crash the loop), but with zero observability
  signal. Middleware now emits `compaction.failed` when wired with an
  EventBus. Backward-compatible.

### Added — new published package

- **`@wrongstack/plug-lsp@0.1.6`** — Language Server Protocol plugin.
  Auto-discovers `tsserver` / `pyright` / `gopls` / `rust-analyzer` in
  the workspace, exposes `lsp_hover`, `lsp_definition`, `lsp_references`,
  `lsp_diagnostics`, `lsp_format_document`, `lsp_rename_symbol` tools.
  Includes `wrongstack-lsp-setup` binary for one-shot install. CLI now
  depends on it as a workspace package.

### Added — per-package READMEs

Each published package now ships its own README so npmjs.com renders
something useful: `core`, `cli`, `providers`, `tools`, `tui`, `mcp`,
`plug-lsp`.

## [0.1.4] — 2026-05-14

### Fixed

- **Umbrella `wrongstack` package republished in lockstep**. 0.1.3 shipped `@wrongstack/cli@0.1.3` but the user-facing `wrongstack` package on npm was accidentally left at 0.1.0 with a pinned `@wrongstack/cli: 0.1.0` dependency, so `npm i -g wrongstack` kept resolving to the pre-observability binary. 0.1.4 re-publishes every package together and `wrongstack@latest` now actually delivers the L0–L3 work.

### Changed

- **License: Apache-2.0 → MIT**. The previous publish landed before the SPDX `"license"` field was added to each package.json, so the registry rendered every package as "Proprietary". Every package now carries `"license": "MIT"` plus the canonical `repository`, `homepage`, `bugs`, and `author` metadata.
- MCP `clientInfo.version` advertised to MCP servers bumped to `0.1.4` (was lagging at `0.1.1`).

## [0.1.3] — 2026-05-14

### Added

- **Streaming for long-running tools** — `install`, `lint`, `format`, `typecheck`, `test`, `audit`, `fetch`, `grep`, `tree`, `search` now yield `partial_output` / `log` / `metric` events via `executeStream`. The TUI live-tails these instead of waiting for the whole tool to finish (L0-A)
- **Typed agent errors** — `RunResult.error` is now `WrongStackError | undefined`; `Agent.run` wraps any non-WSE throw into `AgentError` with code `AGENT_RUN_FAILED`. CLI repl + TUI render `code`, `severity`, `recoverable`. `/diag` shows the last 5 errors (L0-B)
- **Declarative provider configs** — Anthropic, OpenAI, and Google providers re-implemented as `WireFormatConfig` presets. The old subclasses survive as no-op compat wrappers for one minor (L0-C)
- **Plugin teardown + capability runtime check** — loader invokes `plugin.teardown()` on SIGINT and natural exit. When a plugin lies about its `capabilities`, the loader logs a warning instead of silently accepting (L0-D)
- **`Config.extensions` plumbed to plugin loader** — CLI passes `config.extensions` as `pluginOptions` so plugins reading `api.config.extensions[name]` see what the user configured (L0-E)
- **OTel-compatible tracer** — `Agent.run`, `provider.complete`, and `tool.<name>` open spans on a noop-by-default `Tracer`. Plug in an OTLP exporter via `OTelTracer` (L1-C)
- **Multi-agent CLI integration** — `/spawn` slash command, `/agents` status panel, budget visualization on per-subagent task (L1-E)
- **Pipeline middleware error boundary** — `Pipeline.setErrorHandler(fn)` lets a host decide rethrow-vs-swallow when a plugin handler crashes. Default: rethrow (L1-F)
- **SessionReader interface** — `DefaultSessionReader` exposes query (by date/provider/title/minTokens), replay (async-iterable events), full-text/regex search, and export (markdown/json/text) over any `SessionStore` (L2-A)
- **MCP reconnection with exponential backoff + jitter** — capped at 5 cycles, transitions to `failed` state and surfaces in `/diag`. Tool-list cache invalidates on `notifications/tools/list_changed` (L2-B, L2-C)
- **Config v2 migration framework** — `runConfigMigrations(input, targetVersion, migrations)` applies a chain of pure migrations, loop-guarded at 100 steps. Throws `ConfigMigrationError` with the missing step name (L2-D)
- **Inter-agent messaging exercised at API level** — `InMemoryAgentBridge` request/response, broadcast (sender-excluded), and timeout paths covered (L2-E)
- **Per-tool subpath exports** — `import { bashTool } from '@wrongstack/tools/bash'` and every other public tool. Each tool tree-shakes independently of the others (L3-A)
- **HTTP `/metrics` Prometheus scrape endpoint** — `startMetricsServer({ port, sink })` exposes counters/gauges/histograms in Prometheus text format. CLI flag: `--metrics-port`. Defaults to bind on `127.0.0.1`; set `METRICS_HOST=0.0.0.0` for network scraping (L3-C)
- **CI gate** — `.github/workflows/ci.yml` runs `pnpm typecheck && pnpm build && pnpm test`; failure on any step blocks the merge (L3-D)
- **Reactive conversation state** — `ctx.state.appendMessage()` / `ctx.state.replaceMessages()` fire `onChange` events. Subscribed UIs no longer poll. `Agent.run` and every compactor route mutations through this wrapper (L1-A)
- **Benchmark harness** — `pnpm bench` runs `*.bench.ts` files via `vitest bench` against a separate config; JSON output captured to `bench-results.json` for CI artifact diffing (V0-A)
- **Initial benchmarks** — coverage for token estimation, JSON-schema validation, system-prompt build, and the three compactors (V0-B)
- **CLI test coverage uplift** — `boot-config`, `pre-launch`, `multi-agent`, and `auth-menu` now have direct tests (V0-C)

### Changed

- **`defaults/index.ts` is named-exports only** — every public symbol is enumerated; no `export *` (L3-B). Build output is byte-for-byte equivalent; just better surface clarity
- **Removed three unused kernel registries** — `pipeline-registry.ts`, `strategy-registry.ts`, `token-registry.ts` had zero in-repo references and one mention in the dev plan. Deletions confirmed (L3-E)
- **Test flake cleanup** — `search.test.ts` no longer hits live DuckDuckGo (mocked `fetch`); `repl.test.ts` no longer hits a Worker OOM from infinite empty-line loops
- **Version 0.1.0** — all packages bumped to 0.1.0; plugin `apiVersion` minimum now `^0.1.0`
  - Plugins using `apiVersion: "^1.0"` will no longer load — update to `^0.1.0`

### Fixed

- `MCPServerConfig` assignment in `subcommands/index.ts` no longer fails typecheck when DTS regenerates (cast through `unknown` since the on-disk shape is wider than the closed type)

### Notes for tool authors

- **The `Tool` public API is unchanged.** L1-A migrated the *internal* paths to route through `ctx.state`; your tools still receive `Context` and can still mutate `ctx.messages` directly if needed. Subscribers to `ctx.state.onChange` only see mutations made via the wrapper API.
- **The `Tool.executeStream` async generator** is now preferred for long-running tools that produce incremental output. Yield `{ type: 'log', text }`, `{ type: 'partial_output', text }`, or `{ type: 'metric', data }` events, then a terminal `{ type: 'final', output }`. The TUI live-tails these.

## [0.1.0] — 2026-05-13

### Added

- **TUI (React/Ink)** — full-screen terminal UI with alternate screen buffer, streaming text, slash command picker, file picker (`@` token), message queue, and crash recovery
- **Slash command picker** — type `/` to open a fuzzy-filtered dropdown of all commands; navigate with `↑/↓`, accept with `Enter` or `Tab`
- **History scroll** — `PageUp`/`PageDown` (or `Ctrl+K`/`Ctrl+J`) navigate history; `Ctrl+G` jumps to top; auto-scrolls to newest entry unless user scrolled up
- **Streaming throttle** — `provider.text_delta` events buffered at 100ms (~10fps) to eliminate per-character flicker during streaming
- **Queue persistence** — TUI message queue survives crashes; rehydrated on restart with `QueueStore`
- **Crash recovery** — abandoned session lockfiles detected on boot; offers to resume or discard
- **Encrypted secrets** — plaintext `apiKey` fields in config files auto-migrated to AES-GCM vault at `~/.wrongstack/.key`
- **Monorepo structure** — `packages/cli`, `packages/core`, `packages/mcp`, `packages/providers`, `packages/tools` with pnpm workspaces
- **Minimal kernel** — `Container`, `Pipeline`, `EventBus` primitives (under 600 lines total)
- **4 wire-family transports** — `anthropic`, `openai`, `openai-compatible`, `google`
- **Provider catalog** — fetched from `models.dev/api.json`, 24h TTL cache, ~110 providers
- **8 built-in tools** — `read`, `write`, `edit`, `glob`, `grep`, `bash`, `fetch`, `todo`
- **3 additional tools** — `replace` (batch regex replace), `search` (web search), `git` (common operations)
- **5 more tools** — `exec` (restricted shell), `patch` (apply diffs), `json` (parse/query), `diff` (show differences), `tree` (directory tree)
- **11 dev tools** — `lint`, `format`, `typecheck`, `test`, `install`, `audit`, `outdated`, `logs`, `document`, `scaffold`, `kill` (optional)
- **4 meta tools** — `tool_search`, `tool_use`, `batch_tool_use`, `tool_help` for tool introspection and orchestration
- **Mode system** — 8 built-in agent modes (default, code-reviewer, code-auditor, architect, debugger, tester, devops, refactorer) with role-specific prompts
- **Multi-agent system** — `AutonomousRunner` (done-condition loop), `AgentBridge` (in-memory messaging), `MultiAgentCoordinator` (task orchestration, parallel subagents)
- **Spec-driven development** — `SpecParser`, `TaskGenerator`, `TaskTracker`, `TaskFlow` for specification-first workflow with skills `sdd-SKILL.md` and `multi-agent-SKILL.md`
- **Extended session events** — mode_changed, task_*, agent_*, spec_*, skill_*, tool_call_start/end, message_truncated
- **SessionAnalyzer** — query and analyze session events for replay and retrieval
- **Session memory** — `remember`/`forget` for cross-session notes
- **Plugin system** — full `PluginAPI` with container, pipelines, registries for tools/providers/MCP
- **Permission policy** — per-project `trust.json` with allow/deny rules
- **Session compaction** — automatic context summarization to stay within token limits
- **Skills system** — user-global and project-local skills loaded from `~/.wrongstack/skills/`
- **REPL mode** — interactive prompt with command history
- **Slash commands** — `/providers`, `/models`, `/resume`, `/help`
- **Subcommands** — `wstack providers`, `wstack models`, `wstack resume`
- **Biome linting** — project-wide lint and format via Biome
- **Vitest testing** — test suite with coverage support
- **`AGENTS.md`** — project-level conventions committed to repo

### Configuration Added

- **`~/.wrongstack/config.json`** — global provider/model selection
- **`~/.wrongstack/memory.md`** — user-global agent notes
- **Project `/.wrongstack/AGENTS.md`** — shared project conventions
- **`WRONGSTACK_FETCH_ALLOW_PRIVATE=1`** — opt-in to allow localhost in fetch tool

### Fixed

- **Streaming flicker** — per-character Ink re-renders during streaming now throttled at 100ms, eliminating visible flash/jitter on fast providers

## [0.1.0] — 2026-05-13

Initial release.
