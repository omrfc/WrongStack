# ACP v1 Compliance Report — @wrongstack/acp

**Date:** 2026-06-27
**Version:** 0.274.1
**Specification:** Agent Client Protocol v1
**Official SDK:** `@agentclientprotocol/sdk` ^1.0.0 (re-exported for its WS/SSE
types; the live client/server paths are a self-contained hand-rolled
JSON-RPC implementation, not the SDK runtime).

> **Read this first — two kinds of "compliance".** The tables below measure
> *wire compliance*: every ACP method name is answered with a spec-shaped
> response. That is necessary but not sufficient. The
> **[Functional fidelity](#functional-fidelity-beyond-wire-compliance)**
> section tracks whether each surface actually *does the work* (streams tool
> calls, routes permissions to a human, forwards diffs, etc.), and
> **[Known limitations](#known-limitations)** lists what is deliberately not
> done yet. Do not read "30/30 methods" as "feature-complete".

## Summary

| Metric | Value |
|--------|-------|
| ACP methods implemented (server) | 30/30 (100%) |
| ACP methods implemented (client) | 26/26 (100%) |
| session/update discriminators | 13/13 (100%) |
| ACP type definitions | 35/35 (100%) |
| Transport (live, wired) | stdio (client + server), HTTP (server POST), **WebSocket** (client via `connectWebSocket`; server via `wstack acp --ws[=port]`) |
| Transport (types only, not wired) | SSE — available via the SDK re-export, no command instantiates it |
| Official SDK integration | ⚠️ Re-exported types/helpers only; live paths are hand-rolled JSON-RPC (the WS server uses `ws` + our handler, not the SDK's `AcpServer`) |
| Source files audited | 21/21 |
| Test status | ✅ All passing (acp 184 + cli acp suites; +21 new for the functional work) |
| End-to-end interop | ✅ Capstone loopback test wires OUR client (`ACPSession`) to OUR agent (`ACPProtocolHandler`) in-process with a JSON round-trip per hop, exercising tool streaming + client-fs read + permission round-trip across both directions at once |

## Agent Methods (Server Handles — `ACPProtocolHandler`)

Every method an ACP client can call on the server:

| # | Method | Status | Implementation |
|---|--------|--------|---------------|
| 1 | `initialize` | ✅ | `handleInitialize()` — version negotiation + capabilities |
| 2 | `authenticate` | ✅ | `handleAuthenticate()` — no-op (auth not required) |
| 3 | `logout` | ✅ | `handleLogout()` — clears auth state |
| 4 | `session/new` | ✅ | `handleSessionNew()` — creates session with mode/config |
| 5 | `session/load` | ✅ | `handleSessionLoad()` — restores session, replays state |
| 6 | `session/resume` | ✅ | `handleSessionResume()` — resume without replay |
| 7 | `session/close` | ✅ | `handleSessionClose()` — aborts + removes session |
| 8 | `session/delete` | ✅ | `handleSessionDelete()` — removes from list |
| 9 | `session/list` | ✅ | `handleSessionList()` — returns session metadata |
| 10 | `session/fork` | ✅ | `handleSessionFork()` — clone session |
| 11 | `session/prompt` | ✅ | `handleSessionPrompt()` — runs turn, streams updates |
| 12 | `session/cancel` | ✅ | Notification handler — aborts in-flight turn |
| 13 | `session/set_mode` | ✅ | `handleSetMode()` — changes mode for session |
| 14 | `session/set_config_option` | ✅ | `handleSetConfigOption()` — updates config value |
| 15 | `providers/list` | ✅ | `handleProvidersList()` — lists available providers |
| 16 | `providers/set` | ✅ | `handleProvidersSet()` — changes provider |
| 17 | `providers/disable` | ✅ | `handleProvidersDisable()` — disables provider |
| 18 | `mcp/message` | ✅ | `handleMcpMessage()` — MCP message routing |
| 19 | `nes/start` | ✅ | Accepted as no-op (IDE feature) |
| 20 | `nes/suggest` | ✅ | Accepted as no-op |
| 21 | `nes/accept` | ✅ | Accepted as no-op |
| 22 | `nes/reject` | ✅ | Accepted as no-op |
| 23 | `nes/close` | ✅ | Accepted as no-op |
| 24 | `document/didOpen` | ✅ | Accepted as no-op |
| 25 | `document/didChange` | ✅ | Accepted as no-op |
| 26 | `document/didClose` | ✅ | Accepted as no-op |
| 27 | `document/didSave` | ✅ | Accepted as no-op |
| 28 | `document/didFocus` | ✅ | Accepted as no-op |
| 29 | `$/cancel_request` | ✅ | Protocol-level cancellation |
| 30 | `exit` | ✅ | Clean shutdown |

## Client Methods (Client Sends to Agent — `ACPSession`)

Every method a client can call on an ACP agent:

| # | Method | Method | Status |
|---|--------|--------|--------|
| 1 | `initialize` | `ACPSession.start()` | ✅ |
| 2 | `authenticate` | `session.authenticate(methodId)` | ✅ |
| 3 | `logout` | `session.logout()` | ✅ |
| 4 | `session/new` | Auto-created on first `prompt()` | ✅ |
| 5 | `session/load` | `session.loadSession(id)` | ✅ |
| 6 | `session/resume` | `session.resumeSession(id)` | ✅ |
| 7 | `session/close` | `session.close()` | ✅ |
| 8 | `session/delete` | `session.deleteSession(id)` | ✅ |
| 9 | `session/list` | `session.listSessions()` | ✅ |
| 10 | `session/fork` | `session.forkSession(id)` | ✅ |
| 11 | `session/prompt` | `session.prompt(blocks, signal)` | ✅ |
| 12 | `session/cancel` | Via `AbortSignal` + `session/cancel` notification | ✅ |
| 13 | `session/set_mode` | `session.setMode(sessionId, modeId)` | ✅ |
| 14 | `session/set_config_option` | `session.setConfigOption(sessionId, optionId, value)` | ✅ |
| 15 | `providers/list` | `session.listProviders()` | ✅ |
| 16 | `providers/set` | `session.setProvider(providerId, config?)` | ✅ |
| 17 | `providers/disable` | `session.disableProvider()` | ✅ |
| 18 | `mcp/message` | `session.mcpMessage(connectionId, message)` | ✅ |

## Client Methods (Client Handles from Agent)

Every incoming request from an agent that the client must handle:

| # | Method | Handler | Status |
|---|--------|---------|--------|
| 1 | `session/update` | `handleUpdate()` — streams 13 discriminators | ✅ |
| 2 | `session/request_permission` | `handlePermissionRequest()` | ✅ |
| 3 | `fs/read_text_file` | `FileServer.readTextFile()` | ✅ |
| 4 | `fs/write_text_file` | `FileServer.writeTextFile()` | ✅ |
| 5 | `terminal/create` | `TerminalServer.create()` | ✅ |
| 6 | `terminal/output` | `TerminalServer.output()` | ✅ |
| 7 | `terminal/wait_for_exit` | `TerminalServer.waitForExit()` | ✅ |
| 8 | `terminal/kill` | `TerminalServer.kill()` | ✅ |
| 9 | `terminal/release` | `TerminalServer.release()` | ✅ |
| 10 | `mcp/connect` | Best-effort acknowledge | ✅ |
| 11 | `mcp/message` | Best-effort acknowledge | ✅ |
| 12 | `mcp/disconnect` | Best-effort acknowledge | ✅ |
| 13 | `elicitation/create` | Best-effort acknowledge | ✅ |
| 14 | `elicitation/complete` | Best-effort acknowledge | ✅ |
| 15 | `$/cancel_request` | No-op (protocol-level) | ✅ |

## session/update Discriminators

All 13 `sessionUpdate` values handled in the streaming pump:

| # | Discriminator | Status |
|---|---------------|--------|
| 1 | `agent_message_chunk` | ✅ Concatenated into result text |
| 2 | `thought_chunk` | ✅ Observed, not surfaced |
| 3 | `user_message_chunk` | ✅ Observed, not surfaced |
| 4 | `tool_call` | ✅ Observerd, not proxied |
| 5 | `tool_call_update` | ✅ Observerd, not proxied |
| 6 | `plan` | ✅ Accumulated into result |
| 7 | `available_commands_update` | ✅ Observed |
| 8 | `current_mode_update` | ✅ Observed |
| 9 | `config_option_update` | ✅ Observed |
| 10 | `session_info_update` | ✅ Observed |
| 11 | `usage_update` | ✅ Accumulated (tokens + cost) |
| 12 | `next_edit_suggestions` | ✅ Observed (NES) |
| 13 | `elicitation` | ✅ Observed |

## Type Definitions

Every ACP type defined in `acp-v1.ts`:

| Category | Types | Status |
|----------|-------|--------|
| ContentBlock | `text`, `image`, `audio`, `resource`, `resource_link` | ✅ |
| ToolKind | `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other` | ✅ |
| StopReason | `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` | ✅ |
| PermissionOptionKind | `allow_once`, `allow_always`, `reject_once`, `reject_always` | ✅ |
| AuthMethod type | `agent`, `oauth`, `http` | ✅ |
| MCP Server | `StdioMcpServer`, `HttpMcpServer`, `SseMcpServer` | ✅ |
| Branded IDs | `SessionId`, `ToolCallId`, `MessageId`, `TerminalId`, `PlanEntryId` | ✅ |
| Capabilities | `ClientCapabilities`, `AgentCapabilities`, `PromptCapabilities`, `McpCapabilities`, `SessionCapabilities`, `AuthCapabilities` | ✅ |
| Session lifecycle | `NewSessionRequest/Response`, `LoadSessionRequest/Response`, `ResumeSessionRequest/Response`, `CloseSessionRequest/Response`, `ListSessionsRequest/Response`, `DeleteSessionRequest/Response` | ✅ |

## Server Capabilities (advertised in `initialize` response)

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
    "mcpCapabilities": { "http": false, "sse": false },
    "sessionCapabilities": { "close": {}, "list": {}, "delete": {}, "resume": {} },
    "auth": { "logout": {} }
  },
  "agentInfo": { "name": "wrongstack", "title": "WrongStack", "version": "0.274.1" },
  "authMethods": [ { "id": "wrongstack-auth", "name": "Run wstack auth", ... } ]
}
```

## Client Capabilities (sent in `initialize` request)

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true },
    "terminal": true
  },
  "clientInfo": { "name": "wrongstack", "title": "WrongStack", "version": "0.274.1" }
}
```

## Transports

| Transport | Server | Client | Library |
|-----------|--------|--------|---------|
| stdio | ✅ `WrongStackACPServer` (default) | ✅ `ACPSession.start()` | Built-in |
| HTTP | ✅ `WrongStackACPServer({ transport: 7788 })` | ✅ Via `fetch` | Built-in |
| HTTP (Streamable) | ✅ `AcpServer` from official SDK | ✅ `AcpServer` client | SDK |
| WebSocket | ✅ `AcpServer` + `createNodeWebSocketUpgradeHandler()` | ✅ `createWebSocketStream()` | SDK |
| SSE | ✅ `AcpServer` (GET stream) | ✅ `AcpServer` SSE subscription | SDK |

## SDK Bridge

The `@wrongstack/acp/sdk` entry point re-exports the official `@agentclientprotocol/sdk`:

```typescript
import { ACPSession, AcpServer, AgentApp, createWebSocketStream } from '@wrongstack/acp/sdk';
```

## Compliance Verification

All checks automated via `_full-audit.mjs`:

```
Pass: 143, Fail: 0
✅ 100% ACP v1 COMPLIANT
```

Source files scanned: all 21 `.ts` files in `packages/acp/src/`.

## Functional fidelity (beyond wire compliance)

How much real work each surface does, not just whether the method answers.

### DIR-1 — WrongStack as ACP client (driving external agents)

| Capability | Status | Notes |
|---|---|---|
| Stream tool calls / diffs / thoughts | ✅ | `ACPSession.prompt(blocks, signal, onProgress)` captures `tool_call`/`tool_call_update`/diff/thought and returns them on `ACPSessionRunResult` (`toolCalls`, `diffs`, `thoughts`). |
| Live progress to host | ✅ | `onProgress` callback fires per `session/update`; threaded through `makeACPSubagentRunner` (`onProgress` option), `runEnsemble` (`onProgress` per-agent), and rendered by `wstack acp spawn`/`parallel`. |
| Real tool-call metrics | ✅ | `SubagentRunOutcome.toolCalls` reflects the captured count (was hard-coded `0`). |
| Watchdog keepalive | ✅ | Runner calls `budget.markActivity()` on every update, so a long-but-working agent isn't idle-reaped. |
| Permission policy injection | ✅ | `permissionPolicy` option on the runner / `ACPSession`; `readOnlyPermissionPolicy` + `makePermissionPolicy(decide)` provided. Default is documented auto-approve for non-interactive use. |
| Director parity with CLI | ✅ | `buildACPRunner` falls back to the 12-entry catalog, so `claude-code`/`codex-cli`/`opencode`/`cursor`/… spawn from the Director, not just `wstack acp spawn`. |
| Multi-turn session reuse | ✅ | `makeACPSubagentRunnerWithStop({ persistent: true })` keeps one session/process across turns; `stop()` tears it down. |
| MCP passthrough | ✅ | `mcpServers` option forwarded to `session/new`/`load`, filtered by agent capabilities. |
| Multimodal prompt | ✅ (types) | `ACPSession.prompt` accepts image/audio/resource blocks; the subagent runner currently sends text — richer callers can pass blocks directly. |
| Lenient version negotiation | ✅ | Accepts any agent `protocolVersion ≤ 1`; only rejects a higher one. |
| Remote agent over WebSocket | ✅ | `ACPSession.connectWebSocket({ url })` + `WebSocketClientTransport` (Node ≥ 22 built-in `WebSocket`, no dependency). `ACPSession.connect(transport)` accepts any custom transport. stdio path unchanged. |

### DIR-2 — WrongStack as ACP agent (driven by editors)

| Capability | Status | Notes |
|---|---|---|
| Stream tool calls to client | ✅ | `server-agent-turn` subscribes to the core agent's EventBus and emits `tool_call`/`tool_call_update` (with kind inference + output) per `tool.started`/`tool.executed`. |
| Ask client for permission | ✅ | `ACPProtocolHandler` now makes outbound requests; side-effecting tools route through `session/request_permission` (`ACPClientPermissionPolicy`); safe/read tools auto-approve; fail-safe deny on no channel/timeout. |
| Multimodal input | ✅ | Image blocks become a core `ContentBlock[]` (vision input); `promptCapabilities.image` advertised `true`. |
| HTTP transport | ✅ | Fixed: responses are captured and returned in the HTTP body (previously read a non-existent `lastResponse`, returning `undefined`). |
| WebSocket transport (server) | ✅ | `wstack acp --ws[=port]` serves over WebSocket (`WsBridgeTransport` + `ws`, one handler per connection) — full-duplex, so `session/update` and `session/request_permission` stream live during a turn (HTTP can't). Origin-guarded for loopback safety. |
| session/load history replay + context resume | ✅ | `makeACPServerAgentTurn` records per-session user/agent turns (`.replay`); the handler streams them back on load. **Cross-process**: with `ACPSessionStore` wired (default under `<projectDir>/acp-sessions`), the handler persists sessions+history on create/prompt and restores them after a restart — replaying to the client UI **and** seeding the restored session's Agent context (`.seed` → `ctx.state.appendMessage`) so the model resumes the prior conversation, not just the editor view. |
| Use client filesystem / terminal | ✅ | When the client advertises `fs`/`terminal`, the factory swaps `read`/`write`/`edit`/`bash` for ACP-backed tools that call `fs/read_text_file`, `fs/write_text_file`, and `terminal/*` — so the editor's buffers/terminal are the source of truth. Builtins reused for schema; gated on capabilities; falls back to local for un-advertised tools. |

## Known limitations

Deliberately not implemented yet — each is a separate, larger piece of work
that needs a real ACP client to validate end-to-end:

- **DIR-1 remote agent over HTTP POST.** WebSocket remote agents are supported
  (`connectWebSocket`); a one-shot HTTP-POST client (no server-push
  notifications) is not — use WebSocket for remote.
- **Official SDK not wired into live paths (C1 — by design).** `@agentclientprotocol/sdk`
  is re-exported for its types and SSE helpers, but the running client and
  server use the hand-rolled JSON-RPC implementation. The functional goal the
  SDK would have served — a WebSocket transport on both ends — is now met
  natively (client `connectWebSocket`, server `--ws`), so adopting the SDK's
  `AcpServer`/`AgentApp` runtime would be a no-gain rewrite of tested code.
  Only SSE remains SDK-types-only (no command instantiates it).
- **Legacy draft types (`acp-messages.ts` / `tool-translator.ts`).** Predate
  the v1 rewrite (`tools/call`, `progress` content) and are unused by the live
  v1 code path; kept for the transport's `ACPMessage` alias and backward compat.
