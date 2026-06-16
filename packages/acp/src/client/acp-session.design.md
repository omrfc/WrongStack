# `ACPSession` — design

## Goal

Spawn an ACP-supporting agent (Claude Code, Gemini CLI, Codex CLI, …)
as a subprocess, talk the v1 protocol over stdio, and present the result
as a standard `SubagentRunner` so the existing WrongStack multi-agent
machinery (host, coordinator, fleet, TUI) can drive it with no changes.

## Surface

```ts
// packages/acp/src/client/acp-session.ts

export interface ACPSessionOptions {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  role?: string;                  // subagent role label, used in errors
  projectRoot: string;            // fs/terminal sandbox root
  timeoutMs?: number;             // default 300_000
  fileServer?: Partial<FileServerOptions>;
  permissionPolicy?: PermissionPolicy;
  promptCapabilities?: PromptCapabilities; // default: text+resource_link only
}

export interface ACPSessionRunResult {
  /** Concatenated agent text (from agent_message_chunk stream). */
  text: string;
  stopReason: StopReason;
  /** True if the agent emitted any text. */
  hasText: boolean;
  /** Token usage if the agent reported it. */
  usage?: { used: number; size: number; cost?: UsageCost };
  /** Final plan the agent produced, if any. */
  plan?: PlanEntry[];
}

export class ACPSession {
  static start(opts: ACPSessionOptions): Promise<ACPSession>;

  // Drives a single prompt turn and waits for end_turn / terminal
  // stopReason. Throws on protocol / spawn / cancellation errors.
  prompt(text: string, signal: AbortSignal): Promise<ACPSessionRunResult>;

  // Cleanly tear down the session and the child process.
  close(): Promise<void>;
}
```

The session is a stateful object — one per external agent process. The
caller (the runner rewrite) keeps it alive across multiple `prompt()`
calls when it wants to continue a conversation, or calls `close()` after
one shot.

## State machine

```
            ┌─────────┐
   start() →│ created │→ initialize handshake fails
            └────┬────┘→ throws ACPSessionError('init_failed')
                 │ ok
            ┌────▼────┐
            │  ready  │ ← no session bound yet
            └────┬────┘
                 │ prompt()
            ┌────▼────┐  session/new fails
            │sessioning│→ throws 'session_create_failed'
            └────┬────┘
                 │ ok
            ┌────▼────┐
            │prompting│  streams session/update notifications,
            └────┬────┘  waits for session/prompt response.
                 │
                 │  stopReason received
            ┌────▼────┐
            │  done   │ → returns ACPSessionRunResult
            └────┬────┘
                 │ close() OR next prompt()
            ┌────▼────┐
            │ closed  │
            └─────────┘
```

Side state tracked per session:
- `transport: ClientTransport` (owned)
- `sessionId?: SessionId` (set after session/new)
- `agentCapabilities: AgentCapabilities` (parsed from initialize result)
- `pendingPermissionRequests: Map<id, {resolve, reject}>` (for session/request_permission round-trips)
- `pendingFsRequests: Map<id, {resolve, reject}>` (for fs/* round-trips)
- `terminals: Map<TerminalId, {proc, output, exitStatus?}>`
- `accumulatedText: string`, `accumulatedPlan: PlanEntry[]`, `lastUsage?: UsageUpdate`

## Method-by-method wire flow

### `start(opts)` → static factory

```
spawn child process via ClientTransport
send initialize { protocolVersion: 1, clientCapabilities: {fs, terminal, promptCapabilities: {image, embeddedContext}}, clientInfo: {name, title, version}}
await initialize result
assert protocolVersion === 1
capture agentCapabilities
install message dispatch:
  - session/update → stream pump
  - session/request_permission → round-trip
  - fs/read_text_file, fs/write_text_file → sandbox + round-trip
  - terminal/create, terminal/output, terminal/wait_for_exit, terminal/kill, terminal/release → terminal server
  - session/cancel (notification, no response) → ignored (we sent it)
  - any other method → JSON-RPC error -32601 "unknown method"
```

`start()` is what `acp-subagent-runner.ts` will call. The current broken
runner spawns the child, sends a fake `agent/run`, and waits for a
non-existent `tools/call` response — all of which is replaced.

### `prompt(text, signal)` → one turn

```
assert state ∈ {ready, done}
if state == done → session/load (if supported) OR new session
send session/new {cwd, mcpServers: []}   →  {sessionId}
send session/prompt {sessionId, prompt: [{type:'text', text}]}
  →  returns {stopReason}
  OR  throws (e.g. agent died) → surface as error
stream session/update notifications until stopReason returns
return ACPSessionRunResult
```

Cancellation:
```
on signal.abort:
  if state == 'prompting':
    send session/cancel notification (no response expected)
    keep streaming updates per spec ("Agent MAY still send updates
      after session/cancel, Client SHOULD still accept them")
    wait for session/prompt response with stopReason='cancelled'
  else:
    proceed with close()
```

### `close()`

```
send session/close (if session open) — best-effort, swallow errors
transport.stop()   // SIGTERM the child
clear all pending fs/terminal/permission maps
```

## Stream pump (the complex bit)

`session/update` notifications carry a `sessionId` and an `update` whose
`sessionUpdate` discriminator picks the variant. The pump:

```ts
onMessage((msg) => {
  if (msg.method === 'session/update' && msg.id === undefined) {
    handleUpdate(msg.params.update);
    return;
  }
  // session/request_permission is a REQUEST (has id), not a notification
  if (msg.method === 'session/request_permission' && msg.id !== undefined) {
    handlePermissionRequest(msg);
    return;
  }
  // fs/* and terminal/* are REQUESTS
  if (msg.method?.startsWith('fs/') && msg.id !== undefined) {
    handleFsRequest(msg);
    return;
  }
  if (msg.method?.startsWith('terminal/') && msg.id !== undefined) {
    handleTerminalRequest(msg);
    return;
  }
  // session/prompt RESPONSE — the one with the stopReason
  if (msg.method === 'session/prompt' && msg.id === expectedPromptId) {
    handlePromptResponse(msg);
    return;
  }
  // session/new RESPONSE
  if (msg.method === 'session/new' && msg.id === expectedSessionNewId) {
    handleSessionNewResponse(msg);
    return;
  }
  // ignore everything else (agent may send session/cancel in response
  // to a session/cancel WE sent — that's normal, see spec).
});
```

`handleUpdate(update)`:
- `agent_message_chunk` → append to accumulatedText
- `thought_chunk` → optional: log + ignore for now
- `tool_call` / `tool_call_update` → we DO NOT need to forward to WrongStack
  tool execution. The external agent runs its own tools internally; we
  just observe the lifecycle for display purposes (and to honour
  `terminalId` references for our terminal mirror). For v1, log and
  ignore — display of tool calls in the TUI is a separate concern.
- `plan` → store as last plan
- `usage_update` → store as last usage
- `available_commands_update`, `current_mode_update`,
  `config_option_update`, `session_info_update` → log + ignore
- `_unstable_*` and unknown → log + ignore

## File server (sandboxed)

```ts
// packages/acp/src/client/file-server.ts
export interface FileServerOptions {
  /** Absolute path; only files under this root are accessible. */
  projectRoot: string;
}

export class FileServer {
  handle(method: 'fs/read_text_file' | 'fs/write_text_file', params): Promise<unknown>;
}
```

- Reject any path that doesn't resolve under `projectRoot` with
  JSON-RPC error -32602 (invalid params). The path is checked AFTER
  `path.resolve` to defeat `..` traversal.
- Read: `node:fs/promises.readFile`, return `{content: string}`.
- Write: `node:fs/promises.writeFile`, atomic via write-then-rename.
- Both with `AbortSignal.timeout(30_000)`.

## Terminal server

```ts
// packages/acp/src/client/terminal-server.ts
export interface TerminalServerOptions {
  projectRoot: string;
  /** Per-command timeout, default 5 minutes. */
  commandTimeoutMs?: number;
}

export class TerminalServer {
  handle(method, params): Promise<unknown>;
  releaseAll(): void;
}
```

- `terminal/create` → `spawn()` with `shell: false`, `windowsHide: true`,
  cwd = `params.cwd` if inside projectRoot else `projectRoot`,
  return `{terminalId}`. Stash in `terminals` map keyed by `terminalId`.
- `terminal/output` → return accumulated output (bounded by
  `outputByteLimit`, default 1 MB, FIFO truncation).
- `terminal/wait_for_exit` → block on child exit, return
  `{exitCode, signal}`.
- `terminal/kill` → `process.kill()` (default SIGTERM).
- `terminal/release` → kill if alive, remove from map.
- All output is captured to a circular buffer; on `outputByteLimit`
  exceedance, drop the oldest bytes (spec requires "truncation happens
  at a character boundary" — we use TextDecoder for the slicing).

## Permission policy

The session accepts an optional `PermissionPolicy` that gets called
when the agent requests permission. The default policy auto-approves
when the `ctx.signal` is "user-driven" (no abort) and rejects otherwise.
Wiring the full WrongStack permission system is a separate concern;
for v1 the policy is a minimal callable:

```ts
export type PermissionPolicy = (req: {
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  signal: AbortSignal;
}) => Promise<RequestPermissionOutcome>;
```

The runner rewrite can pass a policy that bridges to the existing
WrongStack permission chain if needed.

## Error model

```ts
export type ACPSessionErrorKind =
  | 'spawn_failed'       // child process couldn't be spawned
  | 'init_failed'        // initialize handshake rejected or didn't complete
  | 'protocol_error'     // agent sent a malformed message
  | 'session_create_failed'  // session/new returned error
  | 'prompt_failed'      // session/prompt returned error (non-cancel)
  | 'aborted'            // user-initiated abort
  | 'closed'             // session was closed before the operation
  | 'agent_died'         // child process exited unexpectedly
  | 'unsupported_capability';  // agent doesn't support a feature we needed

export class ACPSessionError extends Error {
  readonly kind: ACPSessionErrorKind;
  readonly cause?: unknown;
}
```

The runner rewrite maps these to `SubagentError` (from the existing
`SubagentErrorKind` enum in `types/multi-agent.ts`):
- `spawn_failed`, `init_failed`, `session_create_failed` → `bridge_failed`
- `prompt_failed` → `unknown` (with the agent's error message)
- `aborted` → `aborted_by_parent`
- `closed` → `unknown`
- `agent_died` → `bridge_failed`
- `protocol_error` → `bridge_failed`
- `unsupported_capability` → `unknown`

## Test strategy

`acp-session.test.ts` with a mock transport that emits canned JSON
streams. Cases:

1. **Happy path** — initialize → session/new → session/prompt →
   stream of `agent_message_chunk` updates → stopReason `end_turn` →
   result.text is the concatenation.
2. **Tool call lifecycle** — agent sends a `tool_call` (terminal kind),
   then `tool_call_update` with the result. The session logs and
   doesn't crash; the terminalId is honoured.
3. **Permission request** — agent sends `session/request_permission` →
   policy returns `selected` → we respond with `{outcome: {outcome:
   'selected', optionId: '...'}}`. Verify the response id matches.
4. **Permission denied** — policy returns `cancelled` → we respond
   with `{outcome: {outcome: 'cancelled'}}` and the session continues.
5. **Cancellation** — abort signal fires mid-prompt → session sends
   `session/cancel` notification → mock agent returns
   `stopReason: 'cancelled'` → result is `{stopReason: 'cancelled'}`.
6. **Agent died** — child process closes mid-prompt → session throws
   `agent_died`.
7. **fs/read_text_file** — agent reads `<projectRoot>/file.txt` →
   `FileServer` returns contents. Reads outside the root are rejected
   with -32602.
8. **fs/write_text_file** — write succeeds; out-of-root write is
   rejected.
9. **terminal lifecycle** — `create` → `output` (returns captured
   stdout) → `wait_for_exit` returns exit code → `release` cleans up.
10. **Plan + usage updates** — agent sends a `plan` and a
    `usage_update`; result carries them.

## Why this design, briefly

- **One class, one transport.** Avoids the "fake protocol" mistake of
  the old runner. The transport stays `ClientTransport` from the
  existing module — we just stop using the bespoke `agent/run` /
  `tools/call` pseudo-protocol.
- **`prompt()` returns, doesn't stream.** The runner adapter wraps
  `prompt()` and forwards text via the bridge's `result` message. Live
  streaming to the TUI is a follow-up (will need bridge `progress`
  messages and a renderer change) — for v1 we buffer.
- **File/terminal servers are their own classes.** They're testable in
  isolation and can be reused if/when WrongStack becomes an ACP
  *client* of itself (e.g. to let an external agent use WrongStack's
  own tools via MCP-over-ACP).
- **Capability-gated features.** `session/load` and `set_mode` are
  advertised by the agent; we only call them if `agentCapabilities`
  says so. Initialise negotiation is the first thing `start()` does
  for this reason.

## File layout

```
packages/acp/src/client/
  acp-session.ts          # ~400 LoC
  acp-session.design.md   # this file
  file-server.ts          # ~80 LoC
  terminal-server.ts      # ~150 LoC
  permission.ts           # ~30 LoC (PermissionPolicy type + default)
  acp-session.test.ts     # ~300 LoC, mock transport
  file-server.test.ts     # ~80 LoC
  terminal-server.test.ts # ~120 LoC
```

Roughly 1,200 LoC across 8 files. Larger than the previous PRs, but
the surface is well-defined and the spec pins every wire interaction.
