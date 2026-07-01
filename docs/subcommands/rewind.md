# `wstack rewind` - Rewind a session's file changes

Reverts the file changes a session made, checkpoint by checkpoint. Every user
prompt in a session is a checkpoint; rewinding restores the workspace files to
how they were at that point, and can optionally truncate the session history
to match.

## Usage

| Command | Effect |
|---|---|
| `wstack rewind --list [sessionId]` | List the session's checkpoints (`[index] timestamp prompt-preview (file count)`) |
| `wstack rewind --all [sessionId]` | Rewind to the session start |
| `wstack rewind --last N [sessionId]` | Rewind the last *N* prompts |
| `wstack rewind --to <index> [sessionId]` | Rewind to a specific checkpoint index |
| `... --resume` | After reverting files, also truncate the session's event history at the checkpoint — so resuming the session continues from that point |

The `sessionId` positional is optional; without it the most recent session is
used. Sessions are read from the global sessions dir
(`~/.wrongstack/sessions/`).

## What it reverts

Only files the session itself changed (tracked per checkpoint). The command
prints each reverted file, reports "No files to revert" when nothing changed
after the target checkpoint, and lists any per-file errors (exit 1 if any).

`--resume` matters when you want to continue the conversation from the
rewound state: without it the files roll back but the session transcript
still contains the later turns.

## Examples

```
wstack rewind --list
wstack rewind --last 2
wstack rewind --to 5 --resume
wstack rewind --all 01JD2K…
```

## Code Reference

- `packages/cli/src/subcommands/handlers/rewind.ts`
- `packages/core/src/storage/session-rewinder.ts`
