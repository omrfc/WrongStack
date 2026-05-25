# /autonomy — Agent Self-Driving Modes

## What it does

Controls how much autonomy the agent has between turns. This drives `DefaultModeStore`-backed autonomy state and, in `eternal` or `eternal-parallel` mode, starts the respective autonomy engine.

In the TUI, `/autonomy` (no args) opens an interactive picker. In the CLI REPL, it shows a status summary.

## Modes

| Mode | Label | Color | Behavior |
|---|---|---|---|
| `off` | OFF | green | Normal interactive mode. Agent stops after each turn. |
| `suggest` | SUGGEST | cyan | After each turn, agent shows next-step suggestions. You pick. |
| `auto` | AUTO | yellow | After each turn, agent picks the best next step and continues. Runs until Esc or Ctrl+C. |
| `eternal` | ETERNITY | red | Goal-driven sense/decide/execute/reflect loop. Requires `/goal`. Forces YOLO on. Runs until `/autonomy stop`, Ctrl+C twice, or `/goal pause`. |
| `eternal-parallel` | PARALLEL | magenta | Fan-out 4–8 subagents per tick. Each tick: decompose → spawn → await → aggregate → loop. Requires `/goal`. Forces YOLO on. |

## Usage

```
/autonomy            → TUI: open picker  |  CLI: show status + goal context + engine state
/autonomy off        → stop all autonomous modes
/autonomy suggest   → enable suggestion mode
/autonomy auto      → enable self-driving mode
/autonomy eternal   → enable eternal loop (requires /goal set first)
/autonomy parallel  → enable parallel fan-out mode (requires /goal set first)
/autonomy stop      → stop eternal or parallel loop gracefully (AbortController — current iteration is cancelled)
/autonomy toggle    → cycle: off → suggest → auto → eternal → parallel → off
```

### Stopping eternal/parallel mode

`/autonomy stop` sends `stopRequested = true` to the engine and calls `onEternalStop`, which sets autonomy back to `off`. The in-flight `agent.run()` receives an AbortSignal and is terminated — the current iteration's work is lost.

To stop **without** cancelling the in-flight iteration, use `/goal pause` instead. The loop exits after the current iteration completes cleanly.

## Eternal mode — loop internals

The engine runs `sense → decide → execute → reflect → sleep → loop`:

| Phase | Description |
|---|---|
| `idle` | No active iteration; loop is about to start one |
| `decide` | Choosing the next task (brainstorm / todo / git / etc.) |
| `execute` | Running the agent with the chosen task directive |
| `reflect` | Recording the outcome (success / failure / aborted / skipped) |
| `sleep` | Backing off before the next iteration (transient error backoff or goal-driven delay) |
| `paused` | `/goal pause` was issued; loop has exited gracefully |
| `stopped` | `/autonomy stop` or engine reached a terminal state |
| `error` | Unrecoverable error during the iteration |

### TUI status bar — live stage

During `/autonomy eternal`, the TUI status bar shows the current phase in line 2 (after the `∞ ETERNITY` chip):

```
● thinking…  │ anthropic/claude-3-5  │ ↑ 12k  ↓ 3k
∞ ETERNITY │ ▶ execute(todo:fix-redirect-uri)  │ ⏱ 14:32
todos ⌛2 ☐3 ✓1  │ 🌐 ▶2 ☐1 ·idle ✓1
```

The stage chip disappears when the loop is not running.

### Brainstorm rotation

After 3 consecutive failures (or 3 consecutive `brainstorm` source iterations that return "nothing to do"), the engine forces a brainstorm rotation to break out of loops.

## Parallel mode — dispatch routing

In `eternal-parallel` mode each tick decomposes the goal into N slot tasks
(pending todos → git-dirty files → leader-brainstormed) and fans them out. Each
slot task is routed through the smart dispatcher (`dispatchAgent`) to the
best-fit agent in the 46-agent catalog:

- the slot spawns **in-role** — the role's budget tier applies (via
  `applyRosterBudget`) and the role's tools/persona prompt are attached for any
  real per-role factory
- a concise persona line (`Acting agent: <name> — <summary>`) is injected into
  the slot's task so the role lands even with the default shared-agent factory
- the journal summary shows `role→task` per slot (visible in `/goal journal`)

Routing is **heuristic-only by default** — keyword scoring against each agent's
capability metadata, instant and with no extra provider call per tick. A task
with no signal falls back to the `executor` generalist. The engine accepts an
optional `dispatchClassifier` for LLM fallback, and `dispatch: false` restores
the legacy generic (`slot-xxxxxx`) fan-out.

## Status output

When running `/autonomy` with no args in the CLI REPL, shows:
- Current mode with colored label (OFF/SUGGEST/AUTO/ETERNAL/PARALLEL)
- Goal text (truncated to 80 chars)
- Engine state + iteration count + journal length
- Cost summary if any usage was recorded
- Recent failure count from last 10 iterations

## Code reference

- `packages/cli/src/slash-commands/autonomy.ts` — slash command
- `packages/core/src/execution/eternal-autonomy.ts` — `EternalAutonomyEngine`
- `packages/core/src/execution/parallel-eternal-engine.ts` — `ParallelEternalEngine`
- `packages/core/src/storage/goal-store.ts` — goal file format
- `packages/cli/src/slash-commands/fleet.ts` — `/fleet` slash command for fleet observability
- `packages/tui/src/components/autonomy-picker.tsx` — TUI interactive picker