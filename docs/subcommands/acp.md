# `wstack acp` - Agent Client Protocol

Runs WrongStack as an ACP-compatible agent over stdio, or delegates a task to
one of the configured ACP-backed agent adapters.

## Usage

| Command | Effect |
|---|---|
| `wstack acp` | Start WrongStack as an ACP server; blocks on stdin/stdout |
| `wstack acp server` | Same as `wstack acp` |
| `wstack acp serve` | Same as `wstack acp` |
| `wstack acp list` | List available ACP agent adapters |
| `wstack acp spawn <agent-id> <task>` | Spawn an ACP agent and wait for its result |
| `wstack acp help` | Show help |

ACP clients such as Zed, JetBrains, and VS Code ACP integrations spawn
`wstack acp` as a subprocess and communicate via stdio JSON-RPC.

## Code Reference

- `packages/cli/src/subcommands/handlers/acp.ts`
- `packages/acp/`
- `packages/core/src/coordination/fleet.ts`
