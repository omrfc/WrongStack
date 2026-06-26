# /settings - Runtime Settings

Views or updates persisted settings without opening an interactive menu. The
command is argument-driven so it works in both the plain REPL and the Ink TUI.

## Usage

| Command | Effect |
|---|---|
| `/settings` | Show current settings |
| `/settings help` | Show command help |
| `/settings delay <seconds>` | Set the auto-proceed delay used by auto autonomy mode; `0` disables it |
| `/settings mode off` | Persist default autonomy mode as off |
| `/settings mode suggest` | Persist default autonomy mode as suggest |
| `/settings mode auto` | Persist default autonomy mode as auto |
| `/settings config-scope global\|project` | Save settings globally or in `<project>/.wrongstack/config.json` |
| `/settings refine on\|off` | Enable or disable prompt refinement |
| `/settings refine-delay <seconds>` | Set prompt refinement preview countdown |
| `/settings context-mode balanced\|frugal\|deep\|archival` | Set context window policy |
| `/settings context-strategy hybrid\|intelligent\|selective` | Set compactor strategy |
| `/settings context-auto-compact on\|off` | Enable or disable automatic compaction |
| `/settings token-saving off\|minimal\|light\|medium\|aggressive` | Set token-saving mode |
| `/settings max-concurrent <n>` | Set max concurrent subagents; `0` means runtime default |
| `/settings reasoning auto\|on\|off` | Set reasoning mode |
| `/settings reasoning-effort none\|minimal\|low\|medium\|high\|xhigh\|max` | Set reasoning effort |
| `/settings reasoning-preserve on\|off` | Preserve thinking across turns |
| `/settings cache-ttl 5m\|1h` | Set prompt cache TTL |
| `/settings semver-part patch\|minor\|major\|auto` | Default part used by `/semver` and the `semver_bump` tool when no explicit part is given |
| `/settings defaults` | Show built-in defaults |

Settings are persisted to the active config scope: global
`~/.wrongstack/config.json`, or project `<project>/.wrongstack/config.json`.

`semver-part` is stored under `extensions["semver-bump"].defaultPart` (the
semver-bump plugin's config key) and always goes to the **global** config —
`extensions` is not project-safe, so a project-scope write would drop it.

## Token-Saving Tier

Token-saving tier can be set with `/settings token-saving ...`, or from the
TUI picker by navigating to **Token Saving** and pressing `←`/`→` to cycle:
`off → minimal → light → medium → aggressive → off`.

At process launch, the CLI flags are still available:

```bash
wrongstack --token-saving-tier minimal
wrongstack --token-saving-tier medium   # same as --token-saving-mode (backward compat)
wrongstack --token-saving-tier off
```

Or set it in the config file:

```jsonc
{ "features": { "tokenSavingMode": "minimal" } }
```

## Defaults

| Setting | Default |
|---|---|
| Auto-proceed delay | `45s` |
| Default autonomy mode | `off` |
| Token-saving tier | `off` |
| Iteration timeout | `5 min` |
| Session timeout | `30 min` |
| Max iterations | `100` |
| Max concurrent subagents | `4` |
| Prompt refinement preview countdown | `60s` |
| Config scope | `global` |
| Semver default part | `patch` |

## Code Reference

- `packages/cli/src/slash-commands/settings.ts`
- `packages/cli/src/settings-menu.ts`
- `packages/tui/src/components/settings-picker.tsx`
- `packages/core/src/types/config.ts`
