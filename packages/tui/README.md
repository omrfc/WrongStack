# @wrongstack/tui

Ink-based terminal UI for the WrongStack agent. Renders the interactive chat panel, status bar, slash-command picker, model picker, todo list, and permission-confirm dialogs.

The TUI is **lazy-loaded** by [`@wrongstack/cli`](../cli) — it only imports React/Ink when the user passes `--tui`. Plain-REPL users pay no startup cost.

## Install

```bash
pnpm add @wrongstack/tui @wrongstack/core
```

You'd only depend on this directly if you're embedding WrongStack inside another tool and want the TUI surface. Otherwise install [`wrongstack`](../../README.md).

## Quick example

```ts
import { runTui } from '@wrongstack/tui';
import { Agent, DefaultEventBus, SlashCommandRegistry, DefaultAttachmentStore } from '@wrongstack/core';

const exitCode = await runTui({
  agent,                          // configured Agent instance
  slashRegistry,                  // SlashCommandRegistry
  attachments: new DefaultAttachmentStore(),
  events: new DefaultEventBus(),
  model: 'claude-sonnet-4-6',
  banner: true,
  yolo: false,
  appVersion: '0.1.6',
  provider: 'anthropic',
  family: 'anthropic',
  keyTail: '…ABC',
  effectiveMaxContext: 200_000,
});

process.exit(exitCode);
```

## What you get

```
┌─ banner ─────────────────────────────────────────────┐
│  wrongstack 0.1.6 — anthropic · claude-sonnet-4-6    │
└──────────────────────────────────────────────────────┘
  user> refactor auth.ts to async/await
  ⠋ thinking (3 tools used · 4.2k tokens · 1.3s)
  …
  > █                                              ⚠ YOLO
  ─────────────────────────────────────────────  ctx 47%
```

- **History pane** — assistant text, tool calls, tool results, errors, turn summaries
- **Streaming text** — partial deltas render live; on abort, partial response is preserved
- **Status bar** — model · provider · context-window % · YOLO chip · spinner
- **Input box** — multi-line buffer with bracketed-paste detection, history (↑/↓), placeholder pills for attachments
- **Pickers** — fuzzy file picker (`@`), slash picker (`/`), model picker (Ctrl+M)
- **Permission dialog** — modal y/n/always/deny for `confirm`-permission tools
- **Todo list** — sidebar reflecting `ctx.todos`
- **Attachments** — images and files dropped into the input become inline content blocks

## Key bindings

| Key | Effect |
|-----|--------|
| `Enter` | Submit |
| `Shift+Enter` (or `\` newline) | Insert newline |
| `Ctrl+C` (once) | Abort current turn |
| `Ctrl+C` (twice) | Exit |
| `Ctrl+D` (empty buffer) | Exit |
| `↑` / `↓` | History navigation when buffer empty |
| `@` | File picker |
| `/` (at start) | Slash command picker |
| `Ctrl+G` | Toggle agents monitor overlay |
| `Ctrl+S` | Edit autonomy settings (default mode + auto-proceed delay); also `/settings` |
| `Esc` | Close any picker / dialog / agents monitor |
| `Ctrl+L` | Clear screen (TUI keeps state — equivalent to scrolling) |

## Options worth knowing

- **`effectiveMaxContext`** — the context-bar denominator. Pass the model-specific value resolved via `ModelsRegistry`, not the family baseline; the 1M Opus variant has a much larger window than the 200k default.
- **`queueStore`** — if set, queued input survives a crash. Without it, queued lines are in-memory only.
- **`onClearHistory`** — invoked from the `/clear` slash command so the TUI can wipe its rendered history entries (keeping just the banner) while `Agent`/memory reset happens elsewhere.

## Architecture

```
runTui                — entry; sets up bracketed paste, signal handlers
  ↓
App (React component) — useReducer-driven state machine
  ↓ dispatches events to ↓
EventBus              — agent.run() emits these, the TUI subscribes
```

State is a single `useReducer` `State` shape with discriminated-union `Action`s. The reducer is exported (`reducer`) and unit-tested.

## License

MIT
