# ACP Ensemble Architecture

WrongStack is a first-class peer in the [Agent Client Protocol v1](https://agentclientprotocol.com/get-started/introduction) — both as a **client** that drives external agents (Claude Code, Gemini CLI, Codex CLI, OpenCode, Cline, etc.) and as a **server** that external editors (Zed, JetBrains Junie, VS Code ACP) can drive. The "ensemble" feature is the user-facing fan-out: one task, multiple agents, parallel execution, aggregated results.

This document is the top-level design reference. See [`docs/subcommands/acp.md`](subcommands/acp.md) for the CLI surface and [`docs/slash/ensemble.md`](slash/ensemble.md) for the in-REPL slash command.

---

## Table of contents

1. [Goals & non-goals](#1-goals--non-goals)
2. [Why ACP](#2-why-acp)
3. [Package layout](#3-package-layout)
4. [Discovery layer](#4-discovery-layer)
5. [Client side: driving external agents](#5-client-side-driving-external-agents)
6. [Server side: being driven by an editor](#6-server-side-being-driven-by-an-editor)
7. [Ensemble orchestrator](#7-ensemble-orchestrator)
8. [Failure modes](#8-failure-modes)
9. [What ships today vs. roadmap](#9-what-ships-today-vs-roadmap)

---

## 1. Goals & non-goals

**Goals**

- **Detect** ACP-capable agents already installed on `$PATH` (Claude Code, Gemini CLI, Codex CLI, Cline, Goose, OpenHands, Copilot, Cursor, Kiro, Qwen Code, OpenCode, Mistral Vibe).
- **Drive** each as a first-class subagent with the same `SubagentRunner` interface as native WrongStack subagents.
- **Implement a v1-correct client** — `initialize` → `session/new` → `session/prompt` → stream `session/update` → `stopReason`.
- **Implement a v1-correct server** — full method set, correct `content` blocks, `tool_call` lifecycle, `session/cancel` propagation.
- **Fan out a single task** to multiple agents concurrently and aggregate the results. This is the user-facing ensemble.

**Non-goals (v1)**

- HTTP/WebSocket transport. The spec calls this "in progress"; v1 stabilizes stdio only.
- Cross-agent session sharing. Each external agent keeps its own session.
- Live multi-tab TUI streaming. Today's `/ensemble` is fully blocking; per-agent live updates are a roadmap item.
- Built-in synthesis step. `/ensemble` doesn't fold the per-agent results into a single answer — the user (or a follow-up agent run) does that.
- Auto-discovery via the ACP Registry HTTP API. The catalog is a static file refreshed in PRs.

---

## 2. Why ACP

The user's original request was: "use together all the ACP-supporting agentic tools (e.g. Claude Code, Gemini CLI, etc.) that are already installed on our system." The `wstack acp` subcommand and `/ensemble` slash command are the answer.

ACP is the right fit because:

- **It's the cross-vendor standard.** Editor vendors (Zed, JetBrains, VS Code ACP) and agent vendors (Anthropic, Google, OpenAI, community) are converging on it. v1 is stable; v2 is in RFD.
- **It models the conversation, not the tool call.** Each agent exposes its own tool surface via `session/prompt`; we don't need to translate a generic tool schema per vendor.
- **It carries the session state.** `session/load` lets an editor resume a session with another agent; the protocol makes that explicit. (We don't use `session/load` in v1, but we don't block it either.)
- **It has a real spec, not a de-facto standard.** agentclientprotocol.com publishes the wire format with versioned RFDs. We can pin to a version and rely on the spec.

What ACP doesn't give us: streaming-token-by-token is not a v1 requirement; `agent_message_chunk` is meant for batching, not token-level streaming. We batch.

---

## 3. Package layout

The integration lives in `packages/acp/`. It depends only on `@wrongstack/core` (for the `SubagentRunner` shape and the `Agent` class the server uses). The CLI consumes it via `@wrongstack/cli`; the TUI consumes it via the same `runEnsemble` import (no TUI-specific code — the slash command is in the CLI package and the TUI inherits it).

```
packages/acp/
  src/
    types/
      acp-messages.ts       legacy draft-protocol envelope (kept for back-compat)
      acp-v1.ts             v1 type definitions — branded IDs, content blocks,
                            tool-call lifecycle, discriminated SessionUpdate union
                            (11 stable kinds + 2 escape hatches)
    registry/
      agents.catalog.ts     12-entry static catalog (one entry per agent)
      ensemble-registry.ts  EnsembleRegistry class — $PATH probe + 5s cache
    client/                 v1 client (WrongStack drives external agents)
      acp-session.ts        v1 state machine
      file-server.ts        fs/read_text_file, fs/write_text_file (sandboxed)
      terminal-server.ts    terminal/create, output, kill, release
      permission.ts         PermissionPolicy interface + default impl
      tool-translator.ts    pure helpers
    agent/                  v1 server (external editors drive WrongStack)
      protocol-handler.ts   v1 method set: initialize, session/new, session/prompt, …
      wrongstack-acp-agent.ts  the bootstrap binary (no-op echo by default)
      server-agent-turn.ts  ACPServerAgentTurn adapter — real Agent wiring
      stdio-transport.ts    JSON-RPC 2.0 over stdio (used by both sides)
      tools-registry.ts     WrongStack Tool → ACP ToolDefinition
    integration/
      acp-subagent-runner.ts  single-agent runner (delegates to ACPSession)
      ensemble-runner.ts    multi-agent orchestrator (used by /ensemble + wstack acp parallel)
    index.ts                public surface
  tests/                    14 files, 153 tests, 1 skipped (live probe)
  scripts/acp-smoke-test.mts end-to-end v1 server smoke harness
```

---

## 4. Discovery layer

**`agents.catalog.ts`** — 12 entries, one per agent. Each entry is a typed object:

```ts
export interface ACPAgentDescriptor {
  id: string;                                    // 'claude-code', 'gemini-cli', …
  displayName: string;                           // 'Claude Code'
  vendor: 'anthropic' | 'google' | 'openai' | 'github' | 'community';
  /** argv[0] probe: `claude --version` etc. */
  probe: { command: string; args?: string[] };
  /** argv to start ACP mode. */
  acp: { command: string; args: string[]; env?: Record<string, string> };
  supports: { loadSession: boolean; promptImages: boolean; terminal: boolean; fs: boolean };
  integration: 'native' | 'adapter' | 'community' | 'experimental';
  docs: string;                                  // https://…
}
```

**Static, not live.** The ACP v1 spec is a moving target and the Registry RFD isn't stabilized; a typed file the maintainer refreshes in PRs is more reliable than a network dependency.

**`EnsembleRegistry`** — probes all entries in parallel via `Promise.allSettled`, caches the result for 5 seconds, returns a `DetectedAgent[]` with `installed`, `version`, `path`, and `reason` fields.

Two Windows-specific quirks the live probe handles:

- `shell: true` for the probe spawn so `.cmd` shims under `AppData\Roaming\npm\` are found.
- Detection of cmd.exe's "`<command>` is not recognized" message so the probe correctly distinguishes "binary exists, runs, prints version" from "binary not on disk".

Live probe on this host (Windows 11, 2026-06-16):

```
✓ claude-code    2.1.178 (Claude Code)
✓ gemini-cli     0.45.1
✓ codex-cli      codex-cli 0.139.0
✓ copilot        Runs the GitHub Copilot CLI.
✓ cline          11.11.0
✓ qwen-code      0.16.0
✓ kiro-cli       0.12.224
✓ opencode       1.15.5
— goose          binary not found
— openhands      binary not found
— mistral-vibe   binary not found
— cursor         binary not found
```

8 of 12 installed.

---

## 5. Client side: driving external agents

**`ACPSession`** is the v1 client. State machine:

```
idle → initializing → ready → prompting → streaming → done
                                              ↘ failed
                                              ↘ cancelled
```

Per session:

1. **Start** — spawn the agent child process via `ClientTransport`, send `initialize { protocolVersion: 1, clientCapabilities: {fs, terminal}, clientInfo }`, assert the response `protocolVersion === 1`.
2. **Prompt** — send `session/new { cwd, mcpServers: [] }`, get `sessionId`, send `session/prompt { sessionId, prompt: [{type: 'text', text}] }`.
3. **Stream pump** — listen for `session/update` notifications:
   - `agent_message_chunk` → bridge text delta
   - `tool_call` → bridge tool start
   - `tool_call_update` → bridge tool end
   - `plan` → bridge plan entries
   - `usage_update` → bridge token/cost counters
   - `_unstable_*` / unknown kinds → log + drop
4. **Answer agent requests:**
   - `fs/read_text_file`, `fs/write_text_file` → `FileServer` (sandboxed to `projectRoot`)
   - `terminal/create`, `terminal/output`, `terminal/release`, `terminal/wait_for_exit`, `terminal/kill` → `TerminalServer` (per-process timeout, 1 MiB output cap with UTF-8-safe FIFO truncation)
   - `session/request_permission` → `PermissionPolicy`
5. **Cancel** — on parent's `AbortSignal`, send `session/cancel` **notification** (no response expected), wait for `stopReason: 'cancelled'`, tear down. Per spec, agents MAY keep sending updates after the cancel — we accept them.

The 32 "sessionUpdate kinds" in the spec's `llms.txt` is a count of RFD page titles; the **stable v1 set is 11**. The union in `acp-v1.ts` covers those 11 plus two escape hatches:

- `UnstableSessionUpdate` — for v2-RFD kinds real agents emit before the spec stabilizes them (`_unstable_next_edit_suggestions`, `_unstable_elicitation`, …).
- `UnknownSessionUpdate` — fallback for forward-compat. Code that switches on the discriminator never has to re-narrow after an unrecognized string.

**`makeACPSubagentRunner`** — thin adapter that takes the agent id (or a direct `{command, args, env}`), resolves it through `EnsembleRegistry` + the catalog fallback, opens a `ClientTransport`, hands it to a new `ACPSession`, and returns a `SubagentRunner` function: `(task, ctx) => TaskResult`. Cancellation, error-kind mapping, and session lifecycle are all delegated to `ACPSession` — the runner is ~60 lines.

**`acp-subagent-runner.ts`** is a single rewrite of what used to be 296 lines speaking a fake `agent/run` / `tools/call` pseudo-protocol. The old test that pinned that protocol (17 tests) was rewritten alongside.

---

## 6. Server side: being driven by an editor

**`WrongStackACPServer`** is the v1 server. The bootstrap binary is `wstack acp server`; it reads JSON-RPC 2.0 from stdin and writes to stdout.

The v1 method set:

| Method | Direction | Notes |
|---|---|---|
| `initialize` | request → result | Negotiates `protocolVersion: 1`, returns `agentCapabilities` |
| `authenticate` | request → result | Optional. Returns "unauthenticated" if a gated tool is needed |
| `session/new` | request → result | Creates a new session; emits `current_mode_update` notification + returns `{sessionId, modes, configOptions}` |
| `session/load` | request → result | Loads a prior session; only enabled if `loadSession: true` |
| `session/prompt` | request → result | Starts a turn; streams `session/update` notifications, returns `{stopReason}` |
| `session/cancel` | notification | No response; cancels in-flight turn + active tool calls |
| `session/set_mode` | request → result | Switches mode, emits `current_mode_update` |
| `session/set_config_option` | request → result | Updates config, emits `config_option_update` |
| `session/list` | request → result | Lists persisted sessions |

Notifications emitted **to the client**:

| Notification | Trigger |
|---|---|
| `session/update` with `agent_message_chunk` | Streamed text from the runTurn |
| `session/update` with `tool_call` / `tool_call_update` | Tool execution lifecycle |
| `session/update` with `plan` | Plan entry changes |
| `session/update` with `usage_update` | Token/cost counters |
| `session/update` with `current_mode_update` | Mode change |
| `session/update` with `config_option_update` | Config change |
| `session/update` with `available_commands_update` | Slash commands change |
| `session/update` with `session_info_update` | Session metadata |

Concurrency is **per-session** (single-threaded per session, with proper `AbortController`-based cancellation). Multiple sessions can run in parallel.

The actual agent loop is delegated to a caller-provided `runTurn` callback: `({ sessionId, prompt, signal }) → { stopReason, text?, plan?, usage? }`. This keeps the handler unit-testable without coupling it to a core `Agent` instance, and lets the maintainer wire it to whatever agent runtime they want.

**`ACPServerAgentTurn`** — `makeACPServerAgentTurn({ agentFor })` returns a `RunTurn` function. The factory takes an `agentFor(sessionId, cwd) → Agent` callback and lazily creates one `Agent` per session on the first `session/prompt` turn. The agent is reused across turns on the same session (per spec: sessions are isolated; sharing an `Agent` across sessions would defeat that).

Per turn:

- Converts the ACP `ContentBlock[]` prompt to a single user-message string. Text blocks are concatenated; non-text blocks become bracketed placeholders (`[image: mime=…]`, `[audio: mime=…]`, `[resource: …]`) — full multimodal support is a future PR.
- Calls `agent.run(userMessage, { signal })` with the parent `AbortSignal` so `session/cancel` propagates correctly.
- Captures the agent's final text and emits it as a single `agent_message_chunk` notification.
- Returns `{ stopReason }` — `cancelled` on abort, `end_turn` otherwise.

Streaming deltas token-by-token is left to a follow-up: the core `Agent` API today returns a final `RunResult`, not a stream. A future PR can use the `Agent`'s `Renderer` hook to capture deltas as they're written, then forward them as multiple `agent_message_chunk` notifications.

The default bootstrap uses a no-op echo `runTurn` so the binary is a useful connectivity smoke test out of the box. Programmatic users pass the result of `makeACPServerAgentTurn({ agentFor: ... })` as `WrongStackACPServerOptions.runTurn`.

**`scripts/acp-smoke-test.mts`** — Node harness that spawns the bootstrap, walks a full session (initialize → authenticate → session/new → session/prompt → session/cancel → exit), and asserts on every response. Wired as `pnpm --filter @wrongstack/acp smoke`. Proves the server's wire format is correct against any v1 client.

---

## 7. Ensemble orchestrator

**`runEnsemble()`** is the user-facing fan-out engine. Pure orchestrator: takes a comma-list of agent ids + a task, returns an `EnsembleResult` with per-agent outcomes (`success` / `failed` / `skipped` / `cancelled`), a roll-up summary, and a total duration. Honours an optional `signal` for cancellation. No renderer dependency.

```ts
export interface EnsembleResult {
  task: string;
  requested: string[];
  results: EnsembleAgentResult[];
  summary: { succeeded: number; failed: number; skipped: number; cancelled: number };
}

export interface EnsembleAgentResult {
  agentId: string;
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  result?: string;
  error?: { kind: string; message: string };
  reason?: string;            // for skipped (e.g. "binary not found")
  durationMs: number;
}
```

Flow:

1. Parse `agentIds` (split on `,`, trim, dedup).
2. For each id, resolve a command via `defaultEnsembleCmdResolver` (legacy `ACP_AGENT_COMMANDS` first, catalog fallback). If unresolved, mark `skipped` with reason.
3. `Promise.allSettled` — for each installed agent, run `ACPSession.start()` → `session.prompt(task)` with a shared `AbortSignal`.
4. Classify each result into `success` / `failed` / `cancelled` based on the `ACPSessionError` kind.
5. Render via `renderEnsembleText()` (or caller's own renderer).

Three entry points consume the same `runEnsemble`:

- **`wstack acp parallel <csv> <task>`** — CLI. Renderer is the formatted text block.
- **`/ensemble <csv> <task>`** — TUI/REPL slash command. Renderer is the same text block, returned to chat history.
- **Programmatic** — `import { runEnsemble } from '@wrongstack/acp'; await runEnsemble({...})` — any script or test.

The 11 ensemble-runner tests cover: argument parsing (empty, dedup), skip / fail classification, concurrent run (asserted via a `liveCount` instrument that proves actual parallelism), per-agent error capture, AbortError → cancelled, pre-aborted signal → all cancelled, and the text renderer.

---

## 8. Failure modes

| Mode | Behavior |
|---|---|
| Agent not installed | `runEnsemble` marks it `skipped` with reason `binary not found`. The CLI prints a warning and continues with the other agents. |
| Agent installed but predates ACP support | The probe's `installed: false, reason: 'binary predates ACP support'`. Same skip path. |
| Agent dies mid-turn | `transport` emits `close`; `ACPSession` reports `TaskResult.status = 'failed'` with `error.kind = 'bridge_failed'`. |
| User aborts (`Ctrl-C`) | `AbortSignal` fires → `runEnsemble` sends `session/cancel` notification to each running agent → waits for `stopReason: 'cancelled'` → marks them `cancelled`. Spec-compliant. |
| Permission prompt from external agent | `session/request_permission` arrives mid-stream → `ACPSession` calls `PermissionPolicy.request({tool, args, reason})` → user accepts/denies in TUI → reply with `outcome`. Reuses the existing `PermissionPolicy` chain. |
| `fs/read_text_file` for a path outside the project sandbox | `FileServer` refuses with JSON-RPC error `-32602`. Does not leak other paths' existence. Sibling-prefix attack (`/project-evil` vs `/project`) is also blocked. |
| Terminal asks to run a destructive command | Funnel through the existing `PermissionPolicy`; never auto-approve. |
| Two ensembles running concurrently against the same `gemini` binary | Each spawns its own process; no shared state. Resource cap is the OS, not us. |
| Agent returns v2-RFD-only updates | `UnstableSessionUpdate` accepts `_unstable_*` discriminator. Logged at debug, not rejected. |
| Agent returns an unknown discriminator | `UnknownSessionUpdate` accepts. Logged, never crashes the session. |
| `wstack acp spawn` for an agent id in the catalog but not the legacy `ACP_AGENT_COMMANDS` map | The catalog fallback in `defaultEnsembleCmdResolver` resolves it. (The pre-existing bug where 7 of 12 installed agents failed at spawn is fixed in 593aefbb.) |

---

## 9. What ships today vs. roadmap

**Ships in v0.263.0 (PR #84):**

- v1 client + server (both spec-compliant, smoke-tested)
- 12-agent static catalog with live $PATH probe
- `wstack acp list` (live detection)
- `wstack acp spawn <id> <task>` (single agent)
- `wstack acp parallel <csv> <task>` (multi-agent fan-out)
- `/ensemble <csv> <task>` (TUI/REPL slash command)
- `makeACPServerAgentTurn` adapter (real `Agent` → server)
- End-to-end smoke test (`pnpm --filter @wrongstack/acp smoke`)

**Roadmap (not started):**

- **Phase 4 — Ensemble UX.** Live tabbed TUI panel for parallel runs; synthesis step that runs a fourth subagent to fold results; save/load "ensemble presets" in `~/.wrongstack/ensembles/*.json`.
- **HTTP/WebSocket transport.** Per spec, "in progress" — wait for the v2 RFD to stabilize before adding.
- **Token-level streaming** in the server (capture `Agent`'s `Renderer` deltas, emit multiple `agent_message_chunk`).
- **Multimodal content blocks** — images, audio, embedded resources in the v1 `ContentBlock[]` prompt.
- **`session/load`** support in the server (resume a prior session).
- **ACP Registry HTTP API** integration for live catalog refresh (when the RFD stabilizes).

---

## Code reference (full)

### Public API surface (`@wrongstack/acp` index)

| Export | Kind | Use |
|---|---|---|
| `EnsembleRegistry` | class | Live detection |
| `AGENTS_CATALOG`, `findAgentDescriptor` | const + fn | Static catalog |
| `ACPSession`, `ACPSessionError` | class + class | v1 client |
| `FileServer`, `FsError` | class + class | Sandboxed filesystem |
| `TerminalServer` | class | Sandboxed terminals |
| `defaultPermissionPolicy` | const | Default permission UX |
| `makeACPSubagentRunner`, `makeACPSubagentRunnerWithStop` | fn + fn | Single-agent runner |
| `makeACPServerAgentTurn` | fn | Real Agent → server adapter |
| `WrongStackACPServer` | class | v1 server bootstrap |
| `StdioTransport`, `ClientTransport` | class + class | JSON-RPC 2.0 over stdio |
| `runEnsemble`, `renderEnsembleText`, `defaultEnsembleCmdResolver` | fn × 3 | Multi-agent orchestrator |
| `EnsembleResult`, `EnsembleAgentResult`, `EnsembleRunnerOptions` | types | Ensemble types |
| `ACPSubagentRunnerOptions` | type | Single-agent runner options |
| `WrongStackACPServerOptions` | type | Server options |
| `DetectedAgent`, `ACPAgentDescriptor`, `ACPAgentVendor`, `ACPIntegration` | types | Catalog types |
| `ACPSessionOptions`, `ACPSessionRunResult`, `ACPSessionErrorKind` | types | Client types |

### Slash command and CLI handler

- `packages/cli/src/slash-commands/ensemble.ts` — `/ensemble`
- `packages/cli/tests/slash-ensemble.test.ts` — 10 unit tests
- `packages/cli/src/subcommands/handlers/acp.ts` — `wstack acp {list,spawn,parallel,server}`

### Tests (14 files, 153 tests + 1 skipped)

- `tests/acp-v1-types.test-d.ts` — type-only test (excluded from vitest)
- `tests/acp-subagent-runner.test.ts` — 8 tests, single-agent runner
- `tests/acp-session.test.ts` — 8 tests, v1 client with mock transport
- `tests/ensemble-runner.test.ts` — 11 tests, multi-agent orchestrator
- `tests/ensemble-registry.test.ts` — 10 tests, registry + 1 live probe
- `tests/file-server.test.ts` — 8 tests, sandboxed fs
- `tests/terminal-server.test.ts` — 7 tests, sandboxed terminals
- `tests/protocol-handler.test.ts` — 15 tests, v1 server
- `tests/server-agent-turn.test.ts` — 4 tests, Agent adapter
- `tests/wrongstack-acp-agent.test.ts` — 5 tests, bootstrap
- `tests/env-sanitization.test.ts` — 3 tests, env passthrough safety
- `tests/barrels.test.ts` — 3 tests, public surface
- `tests/stio-transport.test.ts` — 37 tests, transport
- `tests/tool-translator.test.ts` — 19 tests
- `tests/tools-registry.test.ts` — 16 tests

### Smoke test

- `scripts/acp-smoke-test.mts` — Node harness, walk a full v1 session
- Wired as `pnpm --filter @wrongstack/acp smoke`

---

## Related docs

- [`docs/subcommands/acp.md`](subcommands/acp.md) — CLI surface reference
- [`docs/slash/ensemble.md`](slash/ensemble.md) — `/ensemble` slash command
- [ACP v1 spec](https://agentclientprotocol.com/get-started/introduction) — the protocol itself
