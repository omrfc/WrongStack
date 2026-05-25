# /fleet — Subagent Fleet Controller

## What it does

`/fleet` is the runtime control surface for an active fleet (director mode required for most subcommands). It connects to the `Director` via `opts.onFleet`, `opts.onFleetRetry`, and `opts.onFleetLog`.

## Subcommands

| Usage | Effect |
|---|---|
| `/fleet` | Show fleet status (alias for `/fleet status`) |
| `/fleet status` | Pending + completed task table per subagent |
| `/fleet list` | List the agent roster grouped by phase (role → capability) |
| `/fleet dispatch <task>` | Route a task to the best agent (heuristic + LLM) and spawn it |
| `/fleet usage` | Per-subagent iterations, tool calls, duration, cost rollup |
| `/fleet kill` | Terminate all running subagents |
| `/fleet terminate <id>` | Terminate a specific running subagent |
| `/fleet spawn <role> [n]` | Spawn N subagents of a given role (default 1) |
| `/fleet journal` | Show recent journal entries from /goal journal |
| `/fleet manifest` | Print the director `fleet.json` manifest |
| `/fleet concurrency` | Show the current concurrent-subagent ceiling |
| `/fleet concurrency N` | Set the concurrent ceiling to N (≥ 1) |
| `/fleet retry` | List interrupted tasks from last run |
| `/fleet retry <taskId>` | Re-spawn matching subagent for one task |
| `/fleet retry all` | Re-assign every interrupted task |
| `/fleet log` | List subagent transcript files on disk |
| `/fleet log <id>` | Compact summary of subagent's JSONL transcript |
| `/fleet log <id> raw` | Dump full JSONL for subagent |
| `/fleet stream on\|off` | Show/hide subagent activity in leader's history (TUI only) |

## Fleet data layout

```
<session-dir>/
  fleet.json              ← director manifest (run metadata, children, usage)
  director-state.json    ← live task graph for crash recovery
  subagents/
    <runId>/
      <subagentId>.jsonl ← per-subagent transcript
  shared/                ← optional shared scratchpad
```

## Agent roster

The roster is the 4 legacy pre-built agents plus a 42-agent catalog across 9
phases (Discovery → Meta), defined in `packages/core/src/coordination/agents/`.
Each agent has a scoped tool allowlist and budget tier. Spawn any of them by
role: `/fleet spawn debugger`, `/fleet spawn e2e 2`, or let the dispatcher pick
with `/fleet dispatch "fix the login crash"`. `spawn_subagent role:<role>` works
too. Run `/fleet list` to see every role and its one-line capability.

## Smart dispatch

`/fleet dispatch <task>` scores the task against each agent's capability
keywords (deterministic, instant). When the heuristic is ambiguous it falls
back to an LLM classifier (`onDispatchClassify`, wired to the session provider).
The chosen agent is spawned automatically when a fleet is active.

## Live status line

On the plain (non-TUI) terminal, a bottom-pinned status line shows running
subagents live (`⟳ fleet ▶2 ✓3 │ Debugger ▶ 1m02s L25 14t bash`) via a reserved
scroll region. The TUI's 4th status-bar line shows the same per-agent detail,
including each agent's current tool.

## Never-die timeouts

Subagent budgets auto-extend on a soft-limit. Timeout specifically is
heartbeat-aware: while an agent keeps executing tools it never dies on
wall-clock time (24 h hard ceiling); only an agent making no progress between
grants is denied. Non-director hosts can attach the same policy via
`attachAutoExtend(eventBus)`.

## Code reference

- `packages/cli/src/slash-commands/fleet.ts` — `/fleet` incl. `list` / `dispatch`
- `packages/cli/src/fleet-statusline.ts` — plain-REPL live status line
- `packages/core/src/coordination/agents/` — 42-agent catalog (phases 1-9)
- `packages/core/src/coordination/dispatcher.ts` — heuristic + LLM routing
- `packages/core/src/coordination/auto-extend.ts` — heartbeat auto-extend policy
- `packages/core/src/coordination/director.ts` — director-side auto-extend
- `packages/core/src/coordination/fleet.ts` — roster + budgets
- `packages/core/src/coordination/delegate-tool.ts` — `fleet-retry` tool