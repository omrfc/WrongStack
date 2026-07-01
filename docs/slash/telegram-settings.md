# /telegram-settings — Telegram notification toggles

Controls which agent events the Telegram plugin reports, and its polling /
target-chat settings. Values persist to `extensions.telegram` in the global
config (`~/.wrongstack/config.json`) and apply **immediately** — the plugin
watches config changes, no restart needed.

Alias: `/tg-settings`.

## Subcommands

| Command | Effect |
|---|---|
| `/telegram-settings` | Show current settings (with the exact command to change each). |
| `/telegram-settings session-end on\|off` | Notify when a session ends. |
| `/telegram-settings delegate on\|off` | Notify when a delegated subagent finishes (default on). |
| `/telegram-settings long-tool <ms\|off>` | Notify for tool calls slower than `<ms>` (default 30000; `0`/`off` disables). |
| `/telegram-settings poll <seconds>` | Bot polling interval, 1–60 (default 2). |
| `/telegram-settings chat <chatId>` | Default chat for notifications. |
| `/telegram-settings all on\|off` | Toggle every event notification at once (session-end + delegate). |

## Prerequisite

A bot token must be configured first — the status view warns and points to:

```
/telegram-setup <botToken> [chatId]
```

## Examples

```
/telegram-settings
/telegram-settings session-end on
/telegram-settings long-tool 15000
/telegram-settings chat 123456789
```

See also: `/telegram-setup` (bot token + initial pairing),
`packages/telegram` for the plugin itself.
