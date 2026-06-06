# `wstack replay` - Recorded Provider Responses

Lists recorded provider request/response pairs for a session. The subcommand is
a discoverable inspection wrapper; deterministic re-execution still uses the
top-level `--replay` flag.

## Usage

| Command | Effect |
|---|---|
| `wstack replay <sessionId>` | Inspect recorded replay entries for a session |
| `wstack replay --list` | List sessions that have replay logs |
| `wstack replay -l` | Alias for `--list` |
| `wstack --record` | Start a fresh session recording |
| `wstack --replay <sessionId>` | Re-run using frozen recorded responses |

Replay sidecars live under `~/.wrongstack/projects/<hash>/sessions` and use the
`.replay.jsonl` suffix.

## Code Reference

- `packages/cli/src/subcommands/handlers/replay.ts`
- `packages/core/src/storage/replay-log-store.ts`
- `packages/core/src/utils/wstack-paths.ts`
