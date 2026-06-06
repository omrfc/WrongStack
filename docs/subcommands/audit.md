# `wstack audit` - Tool Audit Log

Inspects a session's tamper-evident tool audit log. Entries are chained with
SHA-256 hashes; `wstack audit` loads the log and verifies whether the chain is
intact.

## Usage

| Command | Effect |
|---|---|
| `wstack audit <sessionId>` | Show entries and verify the hash chain |
| `wstack audit --list` | List sessions that have audit logs |
| `wstack audit -l` | Alias for `--list` |

Audit sidecars live next to project session files under
`~/.wrongstack/projects/<hash>/sessions` and use the `.audit.jsonl` suffix.

## Code Reference

- `packages/cli/src/subcommands/handlers/audit.ts`
- `packages/core/src/storage/tool-audit-log.ts`
- `packages/core/src/utils/wstack-paths.ts`
