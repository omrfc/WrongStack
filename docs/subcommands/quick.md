# `wstack quick` - Launch straight into the TUI

Starts WrongStack directly in the TUI with sensible defaults and the agents
monitor already open — the fastest path from shell to a working session.

## Usage

```
wstack quick
```

No flags of its own; anything else on the command line is handled by the
normal launcher.

## How it works (for contributors)

`quick` is intercepted in `boot()` (`packages/cli/src/boot.ts`) **before**
subcommand dispatch: boot sets `flags.quick` + `flags.tui`, clears the
positional, and the execute path opens the TUI with
`initialAgentsMonitorOpen: true`. The registered handler in
`handlers/quick.ts` is a no-op kept for discoverability and as a fallback if
the boot intercept is ever removed — it is never reached in the real flow.

## Code Reference

- `packages/cli/src/boot.ts` (the actual behavior)
- `packages/cli/src/subcommands/handlers/quick.ts` (registration stub)
