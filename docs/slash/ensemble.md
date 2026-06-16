# /ensemble — Fan a task out to multiple ACP agents

## What it does

`/ensemble` runs a single task on **multiple ACP-supporting agents in parallel** and reports each agent's outcome. The agents are independent external processes (Claude Code, Gemini CLI, Codex CLI, OpenCode, Cline, etc.) that WrongStack talks to over the [Agent Client Protocol v1](https://agentclientprotocol.com/get-started/introduction).

Each agent runs in its own process. Agents that are not installed on the host are **skipped with a warning** rather than failing the whole command. The command waits for all agents to finish and prints a per-agent section followed by a roll-up summary.

This is the TUI/REPL counterpart of `wstack acp parallel` on the command line — both wrap the same `runEnsemble()` orchestrator from `@wrongstack/acp`.

## Usage

```
/ensemble <agent-ids-csv> <task description>
```

The first whitespace-separated token is the comma-separated list of agent ids; everything after it is the task description. Surrounding matched `"..."` or `'...'` around the task are stripped, so the natural form works:

```
/ensemble claude-code,gemini-cli "review this diff"
/ensemble claude-code,codex-cli 'refactor auth/session.ts'
/ensemble claude-code,gemini-cli,codex-cli "explain the v1 protocol"
```

Single-agent form is equivalent to `wstack acp spawn`:

```
/ensemble opencode "summarize this file"
```

Without the agent list, the command prints usage and a hint to run `wstack acp list`:

```
Usage: /ensemble <agent-ids-csv> <task description>

Examples:
  /ensemble claude-code,gemini-cli "review this diff"
  /ensemble claude-code,codex-cli "refactor auth/session.ts"

Run `wstack acp list` to see which agents are detected on this host.
```

## Catalog and discovery

The 12 agents currently in the catalog (as of v0.263):

| id | Vendor | Default command |
|---|---|---|
| `claude-code` | Anthropic | `claude acp` |
| `gemini-cli` | Google | `gemini --acp` |
| `codex-cli` | OpenAI | `codex --acp` |
| `copilot` | GitHub | `gh copilot` |
| `cline` | Community | `cline --acp` |
| `qwen-code` | Community | `qwen acp` |
| `kiro-cli` | Community | `kiro-cli acp` |
| `opencode` | Community | `opencode acp` |
| `goose` | Community | `goose acp` |
| `openhands` | Community | `openhands acp` |
| `mistral-vibe` | Community | `vibe acp` |
| `cursor` | Cursor | `cursor --acp` |

Run `wstack acp list` (or the binary's `acp list` subcommand) to see which are installed on the current host. On the live host as of writing, **8 of 12 are detected** (claude-code 2.1.178, gemini-cli 0.45.1, codex-cli 0.139.0, copilot, cline 11.11.0, qwen-code 0.16.0, kiro-cli 0.12.224, opencode 1.15.5); the remaining 4 (goose, openhands, mistral-vibe, cursor) are skipped if you include them in an ensemble.

## Output

The command returns a single text block to the TUI/REPL chat history. Each agent gets a `=== <id> ===` header and one of four status lines:

```
=== claude-code ===
[success] Reviewed auth/session.ts for null-deref bugs …
[claude-code] succeeded  8421ms

=== gemini-cli ===
[success] Same review from Gemini's perspective …
[gemini-cli] succeeded  7218ms

=== opencode ===
[bridge_failed] opencode: initialize timed out after 30000ms
[opencode] failed  30210ms

=== goose ===
(skipped — binary not found)

Ensemble summary: 2 succeeded, 1 failed, 0 cancelled, 1 skipped. (31203ms total)
```

| Status | When |
|---|---|
| `success` | Agent returned a `stopReason: 'end_turn'` result text |
| `failed` | Agent errored, timed out, or returned a non-success `stopReason` |
| `cancelled` | The command's `AbortSignal` fired (Ctrl-C in the REPL aborts all running agents) |
| `skipped` | Agent id was in the request but the binary is not installed on the host |

The error kind in `[…]` is the structured `SubagentErrorKind` from `@wrongstack/core` (e.g. `bridge_failed`, `aborted_by_parent`, `agent_exited_unexpectedly`, `timeout`, `unsupported_capability`).

## When to use it

Use `/ensemble` when you want multiple perspectives on the same task in one turn:

- **Code review** — run the same review prompt on Claude, Gemini, and Codex to triangulate findings. Each model catches different things; a synthesis step can be added later.
- **Migration planning** — have multiple agents propose a migration plan, then pick the strongest parts of each.
- **Documentation drafts** — generate parallel drafts of a README or ADR section, pick the best.
- **Cross-IDE smoke testing** — when implementing an ACP client, point `/ensemble` at your test fixtures and see how each agent handles them.

For tasks that don't benefit from multiple perspectives, `/spawn` (single WrongStack subagent) or `wstack acp spawn <id>` (single external agent) is the right tool.

## Cancellation

The command honors the REPL's Ctrl-C signal. When the user aborts, `runEnsemble` sends a `session/cancel` notification to each running agent and waits for the spec-compliant `stopReason: 'cancelled'` before tearing down. The summary footer reflects the cancellation count.

## Known limitations

- **Real v1 agents are still early days.** Gemini CLI and Claude Code have working v1 support but each requires its own trust/initialization on first use. On this host, gemini refuses to start without `GEMINI_CLI_TRUST_WORKSPACE=true` (or `--skip-trust`); claude-code accepts the v1 handshake but doesn't return a result within a 30s timeout in the smoke tests.
- **Single text block, not a live panel.** The command is fully blocking — you don't see partial agent output as it arrives. A future PR can add a tabbed TUI panel that streams each agent's session/update notifications live.
- **No synthesis step.** `/ensemble` doesn't fold the per-agent results into a single answer. You (or a follow-up agent run) does that synthesis. Adding a built-in synthesis step is on the roadmap.

## Code reference

- `packages/cli/src/slash-commands/ensemble.ts` — the slash command
- `packages/cli/tests/slash-ensemble.test.ts` — 10 unit tests
- `packages/acp/src/integration/ensemble-runner.ts` — the orchestrator (`runEnsemble`, `renderEnsembleText`, `defaultEnsembleCmdResolver`)
- `packages/acp/src/registry/{agents.catalog,ensemble-registry}.ts` — the 12-agent catalog + `$PATH` probe
- `packages/acp/src/client/acp-session.ts` — the v1 client state machine
- `packages/cli/src/subcommands/handlers/acp.ts` — the `wstack acp` subcommand (sibling CLI surface)
- [ACP Ensemble Architecture](../acp-ensemble.md) — top-level architecture doc
