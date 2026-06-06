# /goal — Autonomous Mission Tracker

## What it does

Sets, inspects, pauses, resumes, or clears the long-running mission used by
`/autonomy eternal`. Goals persist at
`~/.wrongstack/projects/<hash>/goal.json` across sessions, surviving process
restarts.

## Storage format

`goal.json`:
```json
{
  "version": 1,
  "goal": "string",
  "setAt": "ISO timestamp",
  "lastActivityAt": "ISO timestamp",
  "engineState": "idle | running | stopped",
  "goalState": "active | paused | completed | abandoned",
  "iterations": 0,
  "journal": [
    {
      "iteration": 1,
      "task": "what the agent attempted",
      "status": "success | failure | aborted | skipped",
      "source": "brainstorm | todo | git | manual | resume | parallel",
      "note": "optional note",
      "tokens": { "input": 0, "output": 0 },
      "costUsd": 0.00,
      "at": "ISO timestamp"
    }
  ]
}
```

### `goalState` lifecycle

| Value | Meaning |
|-------|---------|
| `active` (default) | Goal is live; engine will run iterations against it |
| `paused` | User ran `/goal pause`; engine exits loop gracefully after current iteration finishes. Run `/goal resume` to continue. |
| `completed` | Engine detected `[GOAL_COMPLETE]` + verification passed; engine refuses to restart |
| `abandoned` | User ran `/goal clear`; engine stops on next iteration check |

Once `goalState` is not `active`, the engine refuses to run further iterations — this protects against accidental restarts burning API quota after work is done.

### Stale goal guard

`/autonomy eternal` refuses to start if the existing goal has `iterations > 0` or `engineState === 'running'`. The user must `/goal clear` first to consciously start a fresh mission.

## Usage

| Usage | Effect |
|---|---|
| `/goal` | Show current goal + recent journal (last 25 entries) |
| `/goal show` | Same as above |
| `/goal status` | Same as above (alias) |
| `/goal set <text>` | Set or replace the goal |
| `/goal new <text>` | Alias for `/goal set` |
| `/goal clear` | Mark goal abandoned, delete goal.json, and stop eternal loop immediately |
| `/goal journal [N]` | Show last N journal entries (default 25) |
| `/goal log [N]` | Alias for `/goal journal` |
| `/goal pause` | Pause loop gracefully after current iteration finishes. State becomes `paused` until `/goal resume`. |
| `/goal resume` | Clear `paused` state and resume the loop from the next iteration. |
| `/goal <any text without verb>` | Treated as `/goal set <text>` |

## Pause / Resume

`/goal pause` writes `goalState: 'paused'` to goal.json. The engine finishes the current iteration then exits the loop cleanly via the existing `missionState !== 'active'` guard — no AbortController, no work lost.

`/goal resume` clears `goalState: 'active'` and the loop continues from the next iteration. If there is no active `/autonomy eternal` running, the state change is persisted and the next `/autonomy eternal` call picks up where it left off.

**Edge cases:**
- `/goal pause` when already paused → no-op, returns "Already paused."
- `/goal resume` when not paused → no-op, returns "Not paused."
- `/goal pause` when no goal exists → returns "No goal set — nothing to pause."
- `/goal pause` while an iteration is in-flight → loop exits after that iteration completes

## Journal entry format

Each iteration writes a journal entry with emoji status indicator:
- ✅ `success` (green checkmark)
- ✗ `failure` (red cross)
- ⊘ `aborted` (amber circle)
- · (dim dot) for unknown status

## Code reference

- `packages/cli/src/slash-commands/goal.ts`
- `packages/core/src/storage/goal-store.ts`
- `packages/core/src/execution/eternal-autonomy.ts`
