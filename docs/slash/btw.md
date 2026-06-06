# /btw — Non-Aborting Mid-Run Steering ("by the way")

## What it does

Stashes a short note for the running agent and surfaces it at the start of the
agent's **next iteration** — between tool batches — without interrupting the
work in flight. Use it to nudge the agent ("by the way, prefer pnpm", "also
check the error path") while it keeps going.

This is the lightweight counterpart to a full steering turn:

| | `/steer` | `/btw` |
|---|---|---|
| Aborts the current iteration | yes | no |
| Terminates the fleet | yes | no |
| Clears the message queue | yes | no |
| When the note lands | immediately (new turn) | next iteration boundary |
| Framing | heavy STEERING preamble | light "by the way" note |

## Usage

```
/btw <note>   Stash a note; the agent reads it at the start of its next
              iteration (between tool calls) without restarting.
/btw          Show how many notes are pending.
```

Multiple notes accumulate in order and are delivered together on the next
iteration. The queue is capped at 20 (oldest dropped). If no run is active, the
note rides along on the next turn the agent takes.

## How it works

1. `/btw <text>` calls `setBtwNote(ctx, text)`, which pushes the note onto
   `ctx.meta._btwNotes` on the live run context.
2. At the top of each iteration — before the request is built — `Agent` drains
   the queue with `consumeBtwNotes(ctx)` and folds the notes into the
   conversation via `buildBtwBlock(...)`. To stay valid across every provider
   wire family, the note is appended to the previous user turn (the
   `tool_result` message) rather than creating a second consecutive user
   message; if the last message is not a user turn, a fresh user message is
   added.

Because delivery happens between tool batches, the note only reaches the model
while the agent is still iterating (i.e. still calling tools). A note set after
the agent has stopped is delivered on its next run.

## Code references

- `packages/core/src/core/btw.ts` — `setBtwNote`, `consumeBtwNotes`,
  `pendingBtwCount`, `buildBtwBlock`
- `packages/core/src/core/agent.ts` — `injectPendingBtwNotes()` (iteration
  boundary drain)
- `packages/cli/src/slash-commands/btw.ts` — the `/btw` command
