# /interrupt

Stop the current run **and every subagent** in one command — without reaching
for ESC or Ctrl+C. Aliases: `/stop`, `/int`.

Useful when the agent is wedged retrying a rate-limited (429) provider, or when
a fleet is off chasing a direction you've abandoned.

## Usage

```
/interrupt        Abort the current leader run and stop all subagents
/interrupt all    Same — stop everything (leader + fleet)
```

## What it does

1. Aborts the in-flight **leader** run (the current iteration).
2. Kills **all** running subagents (the whole fleet).

It reports what it stopped, e.g. `↯ Interrupted leader run + 3 subagents.`, or
`Nothing to interrupt` when idle.

## Per-surface behavior

- **TUI / WebUI** — slash commands dispatch immediately, even mid-run, so
  `/interrupt` stops a run that is stuck retrying a 429 right away.
- **Plain REPL** — the prompt is blocked while a run is in flight, so type
  `/interrupt` at the prompt. To interrupt a run *in progress*, press **Ctrl+C**
  (which now also stops the fleet, not just the leader).

## Related

- `/fleet kill` — stop subagents only, leaving the leader running.
- `/fallback` — auto-rotate to a working model on 429 instead of stopping.
