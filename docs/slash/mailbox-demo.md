# /mailbox-demo — Cross-session mailbox test harness

Demonstrates and tests inter-agent messaging across TUI, WebUI, and CLI
sessions sharing the same project. It acts under a separate demo identity
(`mailbox-demo`) so tests never consume your real agent's unread state —
unlike `/mailbox`, which acts as the session's leader.

## Subcommands

| Command | Effect |
|---|---|
| `/mailbox-demo` / `/mailbox-demo status` | Show the mailbox path and registered agents; registers the demo agent. |
| `/mailbox-demo agents` | List all registered agents with heartbeat age (STALE after 60 s). |
| `/mailbox-demo send <id> <msg>` | Send a test message to a specific agent. |
| `/mailbox-demo broadcast <msg>` | Send `[broadcast] <msg>` to every other registered agent individually. |
| `/mailbox-demo inbox` | Show messages addressed to the demo agent. |
| `/mailbox-demo clear` | Ack (clear) all demo-agent messages. |

## Typical cross-session test

1. Terminal A: `/mailbox-demo status` (registers demo agent, lists who's online)
2. Terminal A: `/mailbox-demo send leader@<tag> "hello from A"`
3. Terminal B: the message is folded into that agent's next iteration
4. Terminal B: `/mailbox-demo broadcast "pong"` → Terminal A: `/mailbox-demo inbox`

## Examples

```
/mailbox-demo status
/mailbox-demo agents
/mailbox-demo send tui:executor "hello from TUI"
/mailbox-demo broadcast "hello everyone"
```

See also: `/mailbox` (the real operator mailbox — identity model, aliases,
read receipts), `/mailbox-serve` (HTTP bridge for external agents).
