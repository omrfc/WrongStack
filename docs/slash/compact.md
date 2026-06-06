# /compact - Context Window Compactor

## What it does

`/compact` runs the configured compactor to summarize older conversation turns and reclaim token budget. This is a proactive manual compaction; automatic compaction also runs through the `contextWindow` pipeline when thresholds are crossed.

## Options

| Usage | Effect |
|---|---|
| `/compact` | Run compactor with default settings |
| `/compact aggressive` | Compact more aggressively |

## Compactor behavior

The active compactor is wired by the host, typically through `HybridCompactor` and the context-window policy. The slash command reports before/after token counts, per-phase reductions, and any repair work:

```text
Compaction: 45000 -> 28000 tokens (user_turns: 8200, tool_calls: 3400); repaired 1 tool_use, 1 tool_result, 0 empty messages
```

## When to use

- Before a long session gets slow
- When many tool calls have made the context heavy
- After a session resume that loaded a large history

## Code reference

- `packages/cli/src/slash-commands/compact.ts`
- `packages/core/src/execution/compactor.ts`
- `packages/core/src/execution/intelligent-compactor.ts`
- `packages/core/src/execution/selective-compactor.ts`
