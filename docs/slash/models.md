# /models - Custom Model Definitions

Manages user-defined model metadata persisted in `~/.wrongstack/config.json`.
This is separate from `/setmodel`: `/models` defines model capabilities, while
`/setmodel` chooses which provider/model the leader or subagents should use.

## Usage

| Command | Effect |
|---|---|
| `/models` | List custom model definitions |
| `/models help` | Show command help |
| `/models add <id> [flags]` | Add or update a custom model definition |
| `/models remove <id>` | Remove a custom model definition |
| `/models rm <id>` | Alias for `remove` |

## Add Flags

| Flag | Effect |
|---|---|
| `--provider <id>` | Owning provider id |
| `--name <display>` | Display name |
| `--max-context <N>` | Override context window |
| `--max-output <N>` | Override max output tokens |
| `--tools` | Mark model as tool-capable |
| `--vision` | Mark model as vision-capable |
| `--streaming` | Mark model as streaming-capable |
| `--reasoning` | Mark model as reasoning-capable |
| `--json-mode` | Mark model as JSON-mode capable |

## Examples

```text
/models
/models add local-qwen --provider openai-compatible --max-context 128000 --tools
/models add vision-pro --vision --streaming
/models remove local-qwen
```

## Code Reference

- `packages/cli/src/slash-commands/models.ts`
- `packages/core/src/types/config.ts`
- `packages/core/src/security/config-secrets.ts`
