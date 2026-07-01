# /audit — Side-effect audit trail

Shows the session's recorded side effects: bash commands, package installs,
network requests — everything the agent did that touched the world outside
the repo, with a risk level per entry.

Aliases: `/sideeffects`, `/side`.

## Usage

| Command | Effect |
|---|---|
| `/audit` | In the TUI: opens the AuditPanel overlay. In the REPL: prints the last 20 side effects inline. |
| `/audit <count>` | Print the last *count* entries inline (max 500). |
| `/audit <risk>` | Filter by risk level: `low`, `medium`, `high`, `critical`. |
| `/audit tool <name>` | Filter by tool-name substring (e.g. `tool bash`). |

Filters compose and can be combined with a count; passing any argument always
renders the inline view (even in the TUI) so the filter takes effect.

## Output format

Each line: time, tool name, risk level, the command/url/packages input
(truncated), and the outcome when recorded:

```
Side Effects (last 20):
  14:03:22  bash     medium  pnpm install left-pad → ok
  14:05:41  fetch    low     https://registry.npmjs.org/…
```

## Examples

```
/audit
/audit 50
/audit high
/audit tool bash 100
```

See also: `/diag` (includes the same side-effect section), `/security`
(security diagnostics).
