# /fleet — Subagent Fleet Controller

## What it does

`/fleet` is the runtime control surface for an active fleet (director mode required for most subcommands). It connects to the `Director` via `opts.onFleet`, `opts.onFleetRetry`, and `opts.onFleetLog`.

## Subcommands

| Usage | Effect |
|---|---|
| `/fleet` | Show fleet status (alias for `/fleet status`) |
| `/fleet status` | Pending + completed task table per subagent |
| `/fleet usage` | Per-subagent iterations, tool calls, duration, cost rollup |
| `/fleet kill <id>` | Terminate a running subagent |
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

## Code reference

- `packages/cli/src/slash-commands/fleet.ts`
- `packages/core/src/coordination/director.ts`
- `packages/core/src/coordination/fleet.ts`
- `packages/core/src/coordination/delegate-tool.ts` — `fleet-retry` tool