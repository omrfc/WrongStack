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
| `/settings semver-part patch\|minor\|major\|auto` | Default part used by `/semver` and the `semver_bump` tool when no explicit part is given |
| `/settings defaults` | Show built-in defaults |

Settings are persisted to `~/.wrongstack/config.json`.

`semver-part` is stored under `extensions["semver-bump"].defaultPart` (the
semver-bump plugin's config key) and always goes to the **global** config —
`extensions` is not project-safe, so a project-scope write would drop it.

## Defaults

| Setting | Default |
|---|---|
| Auto-proceed delay | `45s` |
| Default autonomy mode | `off` |
| Iteration timeout | `5 min` |
| Session timeout | `30 min` |
| Max iterations | `100` |
| Semver default part | `patch` |

## Code Reference

- `packages/cli/src/slash-commands/settings.ts`
- `packages/cli/src/settings-menu.ts`
- `packages/core/src/types/config.ts`
