# `wstack acp` — Agent Client Protocol

WrongStack as an ACP-compatible agent (server) and as a driver of external
ACP agents (client). See [ACP Ensemble Architecture](../acp-ensemble.md) for
the top-level design; this page is the CLI surface reference. To connect a
real editor (Zed, JetBrains, …) and verify each capability, see the
[ACP editor integration guide](../acp-editor-integration.md).

## Usage

| Command | Effect |
|---|---|
| `wstack acp` | Start WrongStack as an ACP server (real agent); blocks on stdin/stdout |
| `wstack acp --echo` | Start the ACP server in no-op echo mode (connectivity test, no provider needed) |
| `wstack acp server` | Same as `wstack acp` |
| `wstack acp serve` | Same as `wstack acp` |
| `wstack acp list` | List ACP-supporting agents detected on this host (live probe) |
| `wstack acp spawn <agent-id> <task>` | Run a task on a single ACP agent and stream the result |
| `wstack acp parallel <agent-ids-csv> <task>` | Fan a task out to multiple ACP agents concurrently |
| `wstack acp help` | Show help |

ACP clients such as Zed, JetBrains, and VS Code ACP integrations spawn
`wstack acp server` as a subprocess and communicate via stdio JSON-RPC 2.0.
The server speaks the v1 spec — see [the v1 protocol reference](https://agentclientprotocol.com/get-started/introduction).

`wstack acp list` is a live probe of the 12-entry catalog in
`packages/acp/src/registry/agents.catalog.ts`. Each entry is checked via
`spawn()` with the platform-appropriate shell flag, and the result is
cached for 5 seconds. Example output:

```
Detected ACP agents:

  ✓ claude-code      Claude Code  (2.1.178 (Claude Code))
  ✓ gemini-cli       Gemini CLI  (0.45.1)
  ✓ codex-cli        Codex CLI  (codex-cli 0.139.0)
  ✓ copilot          GitHub Copilot CLI  (Runs the GitHub Copilot CLI.)
  ✓ cline            Cline  (11.11.0)
  ✓ qwen-code        Qwen Code  (0.16.0)
  ✓ kiro-cli         Kiro CLI  (0.12.224)
  ✓ opencode         OpenCode  (1.15.5)
  ✗ goose            Goose  (binary not found)
  ✗ openhands        OpenHands  (binary not found)
  ✗ mistral-vibe     Mistral Vibe  (binary not found)
  ✗ cursor           Cursor  (binary not found)

8 of 12 agents available.
```

## `wstack acp spawn`

Runs a single task on a single ACP agent and waits for the result.

```
wstack acp spawn <agent-id> <task description>
```

The agent is looked up first in the legacy 5-entry `ACP_AGENT_COMMANDS` map,
then falls back to the 12-entry catalog. The task is sent as a single
`session/prompt` turn; `session/update` notifications are streamed to stderr
(if you want them) and the final `stopReason` and result text are printed to
stdout.

If the agent is not installed, the command exits non-zero with a clear
"not detected" error pointing to the catalog.

## `wstack acp parallel`

Fans a task out to multiple agents concurrently via `Promise.allSettled` and
renders each agent's outcome plus a roll-up summary. Same engine as the
[`/ensemble`](../slash/ensemble.md) slash command.

```
wstack acp parallel claude-code,gemini-cli,codex-cli "review this diff"
```

```
=== claude-code ===
[success] …
[claude-code] succeeded  8.4s

=== gemini-cli ===
[success] …
[gemini-cli] succeeded  7.2s

=== codex-cli ===
[success] …
[codex-cli] succeeded  9.1s

Ensemble summary: 3 succeeded, 0 failed, 0 cancelled, 0 skipped. (9.4s total)
```

Each agent's section is `=== <id> ===`, followed by either the result text
(success), a `[error_kind] message` line (failed), a `(skipped — reason)` line
(not installed), or a `(cancelled)` line. The summary footer rolls up counts
and total wall time.

Agents not installed on the host are **skipped with a warning** rather than
failing the whole command. If all requested agents are missing, the command
prints a single error and exits non-zero.

## `wstack acp server`

Starts the v1 server. By default it wires each ACP session to a real
`@wrongstack/core` `Agent` built from your configured provider/model, so any
ACP-capable client (Zed, JetBrains, VS Code ACP extension, etc.) gets genuine
WrongStack responses over stdio JSON-RPC 2.0.

```
wstack acp            # serves a real agent (needs `wstack auth` first)
wstack acp --echo     # no-op turn; connectivity smoke test, no provider needed
```

Run `wstack auth` first to configure a provider. If none is configured, the
server prints an actionable error and exits rather than silently echoing.

The per-session `Agent` is built by `buildAcpServerAgentFactory`
(`packages/cli/src/acp-server-agent.ts`) and driven by
`makeACPServerAgentTurn` (`@wrongstack/acp/agent`). Each session gets its own
`EventBus` and `Context` for isolation; the provider registry and container are
shared across sessions. The server runs headless under an
`AutoApprovePermissionPolicy` (same posture as subagents) since there is no
interactive permission channel over ACP.

For programmatic control — e.g. a custom agent factory, MCP wiring, or richer
session behaviour — instantiate `WrongStackACPServer` directly with a
`runTurn` of your own:

```ts
import { WrongStackACPServer, makeACPServerAgentTurn } from '@wrongstack/acp';
import { Agent } from '@wrongstack/core';

const server = new WrongStackACPServer({
  runTurn: makeACPServerAgentTurn({
    agentFor: async (sessionId, cwd) => new Agent({ /* … */ }),
  }),
  defaultCwd: process.cwd(),
});
await server.start();
```

See `scripts/acp-smoke-test.mts` for a complete Node harness that walks a
full v1 session and asserts on every response.

## Code reference

- `packages/cli/src/subcommands/handlers/acp.ts` — the CLI handler
- `packages/cli/src/acp-server-agent.ts` — builds a real per-session `Agent` for the server
- `packages/acp/src/integration/acp-subagent-runner.ts` — single-agent runner
- `packages/acp/src/integration/ensemble-runner.ts` — multi-agent orchestrator
- `packages/acp/src/registry/{agents.catalog,ensemble-registry}.ts` — discovery
- `packages/acp/src/client/acp-session.ts` — the v1 client
- `packages/acp/src/agent/{protocol-handler,wrongstack-acp-agent,server-agent-turn}.ts` — the v1 server
- [ACP Ensemble Architecture](../acp-ensemble.md) — top-level design
- [`/ensemble` slash command](../slash/ensemble.md) — the in-REPL counterpart
