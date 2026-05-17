# Plugin Management

WrongStack plugins are regular npm/workspace packages that export a default
`Plugin` object. The CLI loads enabled entries from `config.plugins` when
`features.plugins` is true.

## Commands

```bash
wstack plugin list
wstack plugin status
wstack plugins list
wstack plugin official
wstack plugin install telegram
wstack plugin add @wrongstack/telegram
wstack plugin add @wrongstack/telegram --disabled
wstack plugin disable @wrongstack/telegram
wstack plugin enable @wrongstack/telegram
wstack plugin remove @wrongstack/telegram
```

`plugin` and `plugins` are aliases. `status` is an alias for `list`.
`install` is an alias for `add`.
Official aliases currently include `telegram` -> `@wrongstack/telegram`
and `lsp` -> `@wrongstack/plug-lsp`. `add`, `install`, and `enable` also set
`features.plugins: true` in the global config.
Changes are written to `~/.wrongstack/config.json`.
Official plugins are bundled with the CLI package and published as regular
public packages, so `install telegram` means "add the official plugin to config
and enable plugin loading"; it does not shell out to npm.

The same management surface is available in an interactive session:

```text
/plugin list
/plugin status
/plugin official
/plugin install telegram
/plugin disable telegram
/plugin enable telegram
/plugin remove telegram
```

Slash commands update config immediately, but plugin code is loaded at boot.
Restart WrongStack after install/enable/disable/remove to change the current
session's loaded plugins.

## Config Shape

Plugin loading and plugin options are separate:

```jsonc
{
  "features": {
    "plugins": true
  },
  "plugins": [
    "@wrongstack/telegram",
    { "name": "@wrongstack/plug-lsp", "enabled": false }
  ],
  "extensions": {
    "telegram": {
      "botToken": "123456789:ABCdef...",
      "notifyChatId": "987654321"
    }
  }
}
```

- `plugins` controls which packages are loaded.
- A string entry is enabled by default.
- Object entries can be disabled with `enabled: false`.
- `extensions.<pluginName>` stores that plugin's options and is validated
  against the plugin's `configSchema` during boot.
- Object entries can also carry `options`; WrongStack merges
  `plugins[].options` with `extensions.<pluginName>`, with `extensions`
  taking precedence.

## Telegram

The Telegram bridge lives in this repository as `packages/telegram`, is
published as `@wrongstack/telegram`, and is bundled as the official `telegram`
alias.

```bash
wstack plugin install telegram
```

Then set Telegram-specific options under `extensions.telegram`.

```jsonc
{
  "extensions": {
    "telegram": {
      "botToken": "123456789:ABCdef...",
      "notifyChatId": "987654321",
      "allowedUsers": [987654321],
      "notifyOnSessionEnd": true
    }
  }
}
```

After restart, the plugin registers `telegram_read`, `telegram_send`, and the
`/telegram:*` slash commands declared by the plugin.
