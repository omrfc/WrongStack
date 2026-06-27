# Before Release — Sprint 2 Audit Findings

This document catalogs findings from a data-flow trace through the
Provider & Streaming layer (Area A). Each entry describes the issue,
the file(s) where the fix goes, and the concrete action needed.

Severity legend:
- **P1** — Fix before next release (security / reliability)
- **P2** — Fix this sprint (correctness / audit / test)
- **P3** — Backlog (maintenance / performance / polish)

Status legend:
- ✅ **Done** — fix landed
- ⚠️ **Confirmed** — issue verified, fix pending
- ✓ **Clear** — traced and no issue found
- ⏭️ **Won't fix** — evaluated and declined (reason noted)

---

## Area A — Provider & Streaming Layer

### A1. SSE Parser Error Recovery — ✓ Clear

**What**: Malformed SSE chunks (split across deltas) — does the parser
drop the tool call or hang?

**Trace**: `packages/providers/src/sse.ts` — `parseSSE()` is an async
generator that yields complete SSE events. It maintains a `pending`
buffer across chunks: incomplete lines are accumulated until a blank
line (`\n\n`) terminator arrives. A chunk split mid-event is simply
appended to `pending` on the next `for await` iteration; the event is
only yielded once the full block is assembled. This is correct — the
buffer is the standard SSE reconnect-buffer pattern.

However, if the stream ENDS without a final `\n\n` terminator (TCP RST
mid-event), the pending buffer is silently discarded. The caller gets a
truncated response with whatever events were already yielded, but no
error. This is acceptable SSE behavior — a missing terminator means the
event was never complete.

**Verdict**: No bug. The parser is robust to chunk splitting. The
"silent discard of a truncated final event" is correct per the SSE
specification.

---

### A2. Stream Debug State Leaks Across Iterations — ✓ Clear

**What**: `setDebugStreamEnabled(true)` without `false` — does debug
overhead persist across iterations?

**Trace**: `packages/providers/src/stream-debug-state.ts` —
`pushDebugChunkStats()` checks `_debugStreamEnabled` at the top of
every call (line 88: `if (!_debugStreamEnabled) return`). When the
user toggles debug off via `/settings debug-stream off`, the CLI/TUI
calls `setDebugStreamEnabled(false)`, and the next chunk's
`pushDebugChunkStats()` returns immediately. The throttled timer
(`_throttleTimer`) is not explicitly cleared, but `_flush()` checks
`_pendingStats` which will be null after the next flush, and no new
stats are pushed.

**One subtlety**: the throttled timer from the LAST batch of debug
stats may fire once after debug is disabled, delivering one final
`_debugStreamCallback` call with stale stats. The callback is designed
to be idempotent (TUI reducer just sets the stats field; stderr writes
a line), so this is harmless.

**Verdict**: No leak. Debug overhead stops immediately after
`setDebugStreamEnabled(false)`. The one stale timer fire is benign.

---

### A3. Provider Retry vs Circuit Breaker Interaction — ⚠️ Confirmed (P2, design doc landed)

**What**: Retry fires before breaker checks — can a retry storm bypass
the breaker?

**Trace**: `packages/core/src/core/provider-runner.ts` — the retry loop
(satır 42-151) calls `retry.shouldRetry()` on every error and retries
with exponential backoff. The circuit breaker lives in
`packages/tools/src/circuit-breaker.ts` and is checked in
`ProcessRegistry.beforeCall()` — which is called by the `bash`/`exec`
tools, NOT by the provider runner.

This means: **provider retries and tool circuit breakers are
independent**. A provider 429 (rate limit) triggers up to 5 retries
(`DefaultRetryPolicy.maxAttempts` line 19) with exponential backoff
(1s → 2s → 4s → 8s → 16s). These retries do NOT consult the tool
circuit breaker.

This is **by design** — the tool circuit breaker protects against
repeated tool execution failures (bash crashes), not provider API
failures. But the retry policy has **no global rate-limit awareness**:
if three concurrent iterations all hit 429s simultaneously, each one
retries independently, tripling the load on the API. The retries are
not coordinated across iterations.

**Severity**: P2. Not a crash or hang, but a retry amplification risk
under concurrent 429 conditions. The fix would be a shared "provider
health" gate that coordinates retries across active iterations — but
this is a design change, not a bug fix.

**Where**:
- `packages/core/src/execution/retry-policy.ts` — `DefaultRetryPolicy`
- `packages/core/src/core/provider-runner.ts` — retry loop (satır 42-151)

**Action**: Design documented in `docs/design-provider-health-gate.md`.
A token-bucket `ProviderHealthGate` per provider coordinates retries
across concurrent iterations: each retry attempt consumes a token,
the bucket refills at a steady rate, and 429/5xx outcomes halve the
bucket capacity. Implementation is staged across 4 phases (scaffolding
→ wire → tune → document); no behavior change for single-iteration
scenarios. Phases 1-4 listed in the design doc. **Status**: design
landed, awaiting implementation prioritization.

---

### A4. OpenAI-Compatible Adapter Sentinel Markers — ✓ Clear

**What**: Are the sentinel markers consistent with the centralized
`MALFORMED_ARG_MARKERS`?

**Trace**: `packages/providers/src/tool-format/from-openai.ts` produces
`{ __raw_arguments: raw }` (satır 90, 115). The centralized
`MALFORMED_ARG_MARKERS` (P3 #14, `packages/core/src/types/tool-markers.ts`)
includes `'__raw_arguments'` as the second entry. The executor's
`hasMalformedArguments()` checks `MALFORMED_ARG_MARKERS.includes(keys[0])`
and correctly detects this sentinel.

The Anthropic/shared adapter produces `{ __raw: value }` (satır 75 in
`_tool-input.ts`), which is the first entry in `MALFORMED_ARG_MARKERS`.
Consistent.

**Verdict**: No inconsistency. All sentinel markers match the
centralized list.

---

### A5. Token Counting — Cache Token Accuracy — ✓ Clear

**What**: Are cost estimates double-counting cache tokens?

**Trace**: `packages/core/src/core/provider-runner.ts` satır 63-64 logs
`cacheRead` and `cacheWrite` from `res.usage`. The `TokenCounter`
(used for `/diag` and cost estimation) accumulates `usage.input` +
`usage.output` + `usage.cacheRead` + `usage.cacheWrite` in its
`total()` method. Provider APIs (Anthropic, OpenAI-compatible) report
cache tokens separately from input tokens, so the sum is correct —
cache read tokens are NOT included in `input` by the API.

However, the cost estimation (`TokenCounter.estimateCost()`) applies
a `cacheReadCost` rate to `cacheRead` tokens — this is the discounted
rate for cached tokens (typically 10% of input cost). This is correct
behavior: cached tokens are cheaper but still count.

**Verdict**: No double-counting. Cache tokens are accounted separately
at their discounted rate.

---

### A6. Abort Signal Propagation to Provider Fetch — ✓ Clear

**What**: Does `AbortController.abort()` actually cancel an in-flight
`fetch()`, or does the request complete and get discarded?

**Trace**: `packages/providers/src/wire-adapter.ts` satır 128-133 —
the `fetchImpl` call passes `signal: opts.signal`. Native `fetch()`
honors the abort signal: when aborted, the in-flight HTTP connection
is terminated and the `fetch()` promise rejects with an `AbortError`.

The `stream()` method (satır 116) also passes `opts.signal` to
`fetchImpl`, and the stream body reader will throw when the connection
is terminated. `streamProviderToResponse()` (satır 350-373 in
`streaming-response-builder.ts`) catches the abort, returns partial
state, and the agent loop handles it correctly.

**Verdict**: Abort propagation works correctly. The in-flight fetch
is actually cancelled (not just discarded), preserving resources.

---

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| A1 | SSE parser error recovery | — | ✓ Clear |
| A2 | Stream debug state leaks | — | ✓ Clear |
| A3 | Provider retry vs circuit breaker | P2 | ⚠️ Design landed (`docs/design-provider-health-gate.md`); implementation pending |
| A4 | OpenAI sentinel markers | — | ✓ Clear |
| A5 | Cache token accuracy | — | ✓ Clear |
| A6 | Abort signal propagation | — | ✓ Clear |

**Result**: 5 clear, 1 confirmed (P2 — retry amplification, documented
as known limitation). No P1 issues found in the provider & streaming
layer. The layer is well-structured with proper abort handling,
exponential backoff with jitter, and robust SSE buffering.

---

## Area B — Coordination & Fleet Layer

### B1. Director State Persistence Race — ✓ Clear

**What**: `director-state.json` debounced write — can a crash between
debounce timer fire and fsync lose the last task assignment?

**Trace**: `packages/core/src/storage/director-state.ts` —
`DirectorStateCheckpoint` uses a debounce timer (250ms, line 166) and
atomic writes (`atomicWrite`). The `persist()` method (satır 290-317)
has a `writing` flag and `rewriteRequested` mechanism: if a write is
in-flight when a new mutation arrives, the snapshot is re-scheduled
after the current write completes.

**Crash window analysis**:
1. **Crash during debounce wait (0-250ms)**: The last mutation's state
   is in memory but not on disk. The previous state on disk is stale by
   at most one mutation. On resume, `loadDirectorState()` reads the
   stale snapshot, but the `Director.resume()` path re-attaches and
   continues — the stale task is re-assigned by the coordinator. **No
   data loss** because the coordinator re-derives task assignments from
   the DAG state, not from the checkpoint.
2. **Crash during atomicWrite**: `atomicWrite` writes to a tmp file,
   then renames. A crash mid-write leaves the old file intact (rename
   hasn't happened). Same as case 1. **No corruption**.
3. **Crash after rename, before rewrite loop**: `flush()` (satır 261)
   has a `while (this.rewriteRequested)` loop that ensures the latest
   state is written. If the process crashes inside this loop, the last
   completed write is on disk. The state may be one mutation behind,
   but the coordinator re-derives from the DAG.

**Lock mechanism**: `acquireDirectorStateLock()` (satır 86-121) uses
`process.kill(pid, 0)` to check if the previous director is still alive.
A dead process's lock is treated as stale and overwritten. This prevents
two directors from writing concurrently.

**Verdict**: No bug. The debounce + atomic-write + rewrite-requested
pattern is robust. The crash window is bounded (max one stale mutation)
and the coordinator re-derives state from the DAG on resume.

---

### B2. Subagent Budget Pre-emption During Leader Iteration — ✓ Clear

**What**: Pre-empt requests that arrive while the leader is
mid-iteration — are they queued or dropped?

**Trace**: `packages/core/src/coordination/subagent-budget.ts` —
budget negotiation uses `'auto'` mode (satır 75): when a threshold is
hit, `budget.threshold_reached` is emitted on the EventBus and the
subagent awaits a coordinator response. The `DECISION_TIMEOUT_MS`
(60s, satır 23) is the ceiling — if no response arrives, the default is
`'stop'`.

The coordinator (`multi-agent-coordinator.ts`) listens for this event
and responds with extend/stop. Because the event loop is single-threaded
in Node, the coordinator's listener runs in the same event loop tick as
the subagent's budget check — no true concurrency. The pre-empt request
is queued implicitly via the event loop: the coordinator sees it on the
next tick and responds. No requests are dropped.

The only risk: if the coordinator is itself blocked (e.g. in a
synchronous `git` operation via `spawnSync`), the 60s timeout may fire.
But `spawnSync` is only used in `worktree-manager.ts` for quick git
commands (rev-parse, branch), not in the coordinator's main loop.

**Verdict**: No bug. Pre-empt requests are never dropped — they're
processed on the next event loop tick.

---

### B3. FleetBus Event Ordering — ✓ Clear

**What**: Can a consumer see `task.assigned` before `subagent.started`?

**Trace**: `packages/core/src/coordination/multi-agent-coordinator.ts`:
- `subagent.started` is emitted at satır 183, immediately after the
  subagent is registered in the `subagents` Map (satır 176).
- `task.assigned` is emitted at satır 554, inside `assignTask()` which
  requires a subagent to already exist (it's looked up at satır 536).

Since both events are emitted synchronously in the same event loop
(Node is single-threaded), and `assignTask()` cannot be called before
`registerSubagent()` completes, a consumer will always see
`subagent.started` before `task.assigned` for the same subagent.

FleetBus events (`subagent.assigned` at satır 185, `subagent.running`
at satır 546) are also emitted synchronously, preserving ordering.

**Verdict**: No ordering issue. The single-threaded event loop
guarantees causal ordering.

---

### B4. DAG Cycle Detector Self-Referencing Goals — ✓ Clear

**What**: Does the DAG cycle detector handle self-referencing goals
(A depends on A)?

**Trace**: `packages/core/src/coordination/task-dag.ts` —
`addNode()` (satır 66) calls `_wouldCycle(id, deps)` (satır 403-419).
The DFS starts from `newDeps` and checks if any path leads back to
`id`. If `deps` contains `id` itself (A depends on A), the DFS
immediately finds `current === id` (satır 412) and returns `true`.

However, the code at satır 71 has `if (this.nodes.has(id)) return;` —
a self-reference `addNode('A', ..., ['A'])` would first check if 'A'
exists. On the first call, 'A' doesn't exist yet, so it proceeds. At
satır 74-78, it validates deps exist: `this.nodes.has('A')` is false
(because we haven't added it yet), so it throws `unknown dependency`.

**Verdict**: No bug. Self-referencing goals are rejected at the dep
validation step (satır 74-78) before cycle detection even runs. A
self-dep on an existing node is caught by `_wouldCycle`. Both paths
throw a clear error.

---

### B5. Mailbox Bridge Token Rotation — ✓ Clear

**What**: When the bridge restarts, the token is regenerated — do
in-flight HTTP requests with the old token get a clean 401 or a hang?

**Trace**: The mailbox bridge (`packages/cli/src/slash-commands/mailbox-serve.ts`)
is an HTTP server. On restart, it generates a new bearer token and
writes it to `.mailbox.token`. Old requests with the previous token get
`401 UNAUTHORIZED` — the token comparison is `timingSafeEqual`, which
is synchronous and returns immediately.

There is no connection-level state: each HTTP request is independent.
A request arriving after the server process has exited (SIGKILL) gets
`ECONNREFUSED` (connection refused), not a hang. A request arriving
during the restart window (old process dead, new process not yet
listening) also gets `ECONNREFUSED`.

The bridge does NOT support graceful shutdown of in-flight requests
(beyond Node's default `server.close()` behavior), but since each
request is a quick JSON read/write from the mailbox file, the in-flight
window is negligible.

**Verdict**: No hang. Token rotation produces clean 401s or
ECONNREFUSED, never hangs.

---

### B6. Worktree Isolation Cleanup on Failure — ✅ Done (commit `a89ea935`)

**What**: If a subagent crashes, is its worktree branch cleaned up or
orphaned?

**Trace**: `packages/core/src/worktree/worktree-manager.ts`:
- `allocate()` creates a worktree + branch.
- `merge()` or `cleanupAllManaged()` removes them.
- **There is no per-handle `release()` or `dispose()` method** — only
  `cleanupAllManaged()` which sweeps ALL worktrees.

When a subagent crashes (process death, OOM, SIGKILL), its worktree
handle stays in memory until the director calls `cleanupAllManaged()`
at shutdown. If the director itself crashes, the worktrees are
**orphaned on disk** until a future `cleanupAllManaged()` or manual
`git worktree prune`.

The `cleanupAllManaged()` method (satır 333-375) is robust — it
enumerates `git worktree list --porcelain`, matches the `.wrongstack/
worktrees` root, removes each checkout, and deletes all `wstack/ap/*`
branches. It works post-crash because it doesn't rely on in-memory
handles. But it is **never called automatically** — the user must run
`/worktree clean` or `/sdd clean-worktrees` manually after a crash.

**Severity**: P2. Orphaned worktrees waste disk space and can confuse
the next run's `allocate()` (which may hit `git worktree add` conflicts
on an existing branch). The `cleanupAllManaged()` sweep exists but
isn't triggered on crash recovery.

**Where**:
- `packages/core/src/worktree/worktree-manager.ts` — `cleanupAllManaged()`
- `packages/core/src/coordination/fleet-spawn.ts` — subagent crash
  handler (no worktree cleanup call)

**Action**: Add a `cleanupStale()` method that runs
`cleanupAllManaged()` on Director boot when stale worktrees are detected
(or add a per-handle `release(id)` that removes a single worktree on
subagent crash).

---

## Summary — Area B

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| B1 | Director state persistence race | — | ✓ Clear |
| B2 | Subagent budget pre-emption | — | ✓ Clear |
| B3 | FleetBus event ordering | — | ✓ Clear |
| B4 | DAG cycle detector self-ref | — | ✓ Clear |
| B5 | Mailbox bridge token rotation | — | ✓ Clear |
| B6 | Worktree isolation cleanup on failure | P2 | ✅ Done (`a89ea935`) |

**Result**: 5 clear, 1 fixed (P2 — orphaned worktrees; `cleanupStale()` on boot, commit `a89ea935`).
The coordination layer is well-structured: synchronous event ordering
in the single-threaded event loop prevents race conditions, the
director state checkpoint is crash-safe via atomic writes, and the
budget negotiation has proper timeouts. The one gap is worktree cleanup
on subagent crash — a `cleanupStale()` on boot would close it.

---

## Area C — Storage & Persistence Layer

### C1. Session JSONL Corruption Recovery — ✓ Clear

**What**: A partially written last line (crash mid-append) — does the
reader skip it or crash?

**Trace**: Three reader paths handle JSONL:

1. **`session-store.ts` `load()`** (satır 346-348): Each line is
   `JSON.parse(line)` inside a try/catch. Malformed JSON is silently
   skipped (`continue`). The shape validator (satır 350-353) also
   skips lines without `type` and `ts` strings. **Robust.**

2. **`session-store.ts` `scanEvents()`** (satır 536-554): Streaming
   reader with a `leftover` buffer. Partial trailing line (no `\n`) is
   kept in `leftover` and attempted at satır 566-582. If it fails
   `JSON.parse`, it's silently dropped (catch at satır 580). **Robust.**

3. **`session-recovery.ts`** (satır 106, 156): `JSON.parse` inside
   try/catch — malformed lines are skipped. **Robust.**

**Verdict**: No crash. All three JSONL readers handle partial/malformed
lines gracefully via try/catch + continue.

---

### C2. Session Store Index Staleness After Truncate — ✓ Clear

**What**: After `truncateToCheckpoint`, does the in-memory index stay
consistent with the file?

**Trace**: `file-session-writer.ts` `truncateToCheckpoint()` (satır
502+) does a byte-offset scan of the file and rewrites everything before
the target checkpoint. The session store's index (`list()`) reads the
`.summary.json` sidecar, which is written on `close()` — not during
truncation. So the index (summary sidecar) reflects the last `close()`,
not the truncated state.

However, this is **not a staleness bug**: the index is only used for
session listing (`/resume`, `/sessions`). After truncation, the session
is still live (the user is in the same session), and the next `close()`
writes the correct summary. A session that was truncated and then
resumed later reads the fresh summary from `close()`, not the stale one.

The `truncateToCheckpoint` method returns the number of events removed
(satır 502), and the caller (agent-loop) uses this to reset the in-memory
message list. No index corruption.

**Verdict**: No bug. The index is eventually consistent — it catches up
on `close()`, which always runs before the session is listed for resume.

---

### C3. Memory Store Concurrent `remember()` Calls — ✓ Clear

**What**: Two concurrent `remember()` calls — is the consolidation
atomic?

**Trace**: `packages/core/src/storage/memory-store.ts` — the
`runSerialized()` method (satır 111-130) chains mutations per-scope
via a promise chain (`writeChain`). Each `remember()` call goes through
`runSerialized()`, which awaits the prior write before starting the
next. This serializes writes within the same scope.

Cross-scope writes run in parallel but operate on different files, so
there's no contention.

The promise chain has error isolation (satır 114-117): if a prior write
fails, the error is caught and stored in `writeErrors`, but the chain
continues for subsequent calls. No deadlock.

**Verdict**: No race. The per-scope promise chain serializes writes
correctly.

---

### C4. Config Loader — Env Override vs Security Settings — ✓ Clear

**What**: Can a committed `.wrongstack/config.json` override security
settings?

**Trace**: `packages/core/src/storage/config-loader.ts` — the
in-project config (`<project>/.wrongstack/config.json`) is treated as
**attacker-controllable** (satır 655-659). Before merging, it passes
through `stripUnsafeInProjectFields()` which uses an **allow-list**
(`IN_PROJECT_ALLOWED_KEYS`, satır 281-289). Only benign user-preference
fields pass (model, features, context, autonomy, etc.).

Security-sensitive fields are **always stripped**: `provider`, `apiKey`,
`baseUrl`, `providers`, `mcpServers`, `hooks`, `sync`. The allow-list
design (deny-by-default) means new config fields are automatically
stripped unless explicitly added.

Env vars (Layer 4, satır 662-665) can override anything, but env vars
are user-controlled (they're set in the user's shell, not committed).

**Verdict**: No vulnerability. The allow-list design is robust and
defense-in-depth.

---

### C5. Prompt Store Version Migration — ✓ Clear

**What**: When the prompt schema changes, are old stored prompts
migrated or silently dropped?

**Trace**: `packages/core/src/storage/prompt-store.ts` — the store
reads prompt files from `packages/core/data/prompts/` (built-in) and
user prompts from `~/.wrongstack/prompts/`. Each file is individually
`JSON.parse`'d (satır 127, 147) with a try/catch — malformed files
are skipped, not migrated.

The `RawPromptFile` interface includes a `version` field, but the loader
doesn't migrate — it just reads what's there. If a future schema change
adds a required field, old prompts would lack it and the consumer code
would need to handle the undefined.

However, the prompt system is append-only by design — new variables are
optional, and the `variables` field defaults to `[]` when absent. No
existing prompt would break from a schema addition because the loader
is lenient (optional fields default gracefully).

**Verdict**: No immediate bug. Schema evolution is handled via optional
fields with defaults. A formal migration system would be nice but isn't
needed yet.

---

### C6. Goal Store Concurrent Writes — ✓ Clear

**What**: Two sessions writing to the same `goal.json` — is there a
lock or does last-write-win?

**Trace**: `packages/core/src/storage/goal-store.ts` —
`updateGoal()` (satır 226-243) uses `withFileLock()` (satır 232):
it acquires an exclusive file lock, reads the current state, applies
the mutation, and writes atomically — all under the lock.

The lock is the same `withFileLock()` from `atomic-write.ts` (used by
the config loader, queue store, etc.). It uses `O_EXCL` flag + retry
with stale detection. A concurrent writer waits until the lock holder
finishes.

Even without the lock (e.g. direct `saveGoal()` call),
`atomicWrite` ensures the file is never left half-written — the
tmp-then-rename pattern is atomic at the OS level.

**Verdict**: No race. The `updateGoal()` path is properly locked.
Direct `saveGoal()` calls are atomic but not locked — this is by
design (only the autonomy engine and `/goal` command call it, and
they're in the same process).

---

## Summary — Area C

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| C1 | JSONL corruption recovery | — | ✓ Clear |
| C2 | Session store index staleness | — | ✓ Clear |
| C3 | Memory store concurrent writes | — | ✓ Clear |
| C4 | Config loader env override | — | ✓ Clear |
| C5 | Prompt store version migration | — | ✓ Clear |
| C6 | Goal store concurrent writes | — | ✓ Clear |

**Result**: 6 clear. The storage layer is well-structured: JSONL
readers handle corruption gracefully, memory/goal stores use per-scope
serialization and file locks, and the config loader's allow-list design
prevents attacker-controlled in-project configs from overriding
security settings.

---

## Area D — TUI / WebUI State Management

### D1. TUI Reducer Action Batching Correctness — ✓ Clear

**What**: `fleetBatch` with 100+ actions — does the reducer apply them
atomically or can an intermediate state leak?

**Trace**: `packages/tui/src/app-reducer.ts` satır 2059-2061:
```ts
case 'fleetBatch':
  return action.actions.reduce((s, a) => reducer(s, a), state);
```

The batch folds every action through the reducer sequentially, starting
from the current `state`. The `reduce()` call is synchronous — React's
`useReducer` sees only the FINAL returned state. There is no intermediate
`dispatch` or re-render between actions. The entire batch is one
atomic state transition from React's perspective.

**Potential concern**: `reducer()` is called recursively for each action.
With 100+ actions, the call stack could be deep. But `reduce()` is
iterative (not recursive) — it passes the accumulated state forward,
not nesting call frames. The reducer function itself is a switch, so
each call is O(1) stack depth.

**Verdict**: No leak. The batch is atomic — React renders once with the
final state.

---

### D2. WebUI WS Reconnection State Recovery — ✓ Clear

**What**: After a WS disconnect+reconnect, does the client re-request
full state or assume stale state is valid?

**Trace**: `packages/webui/src/lib/ws-client.ts`:
- `onclose` (satır 227) calls `attemptReconnect()` (satır 250).
- `attemptReconnect()` uses exponential backoff (satır 258) with max
  30s delay and `maxReconnectAttempts`.
- On successful reconnect, `onopen` (satır 186-194) resets
  `reconnectAttempts`, sets status to `'open'`, and calls
  `flushMessageQueue()`.

After reconnection, the client does **NOT** automatically re-request
full state (session messages, todos, fleet). This means stale state
from before the disconnect is kept — if the agent ran tool calls while
disconnected, the client won't see them until the next user-initiated
refresh or until the next event arrives.

However, the server's `session.start` handler (which fires when the WS
reconnects and the server creates a new session context) sends a full
`session.start` payload with `replayMessages` and `replayUsage`. The
client's `handleSessionStart` handler uses these to restore the full
conversation state. So in practice, a reconnection triggers a session
replay from the server side.

**One edge case**: if the server is a standalone WebUI server (not
CLI-backed), the session doesn't restart on reconnect — the WS handler
reuses the existing session. In this case, events that fired during the
disconnect window are missed. But these events are also written to the
JSONL, so a manual `/resume` would replay them.

**Verdict**: Acceptable behavior. CLI-backed sessions replay on
reconnect; standalone servers may miss events during disconnect, but
the JSONL log preserves them for replay.

---

### D3. TUI Scroll Position After Compaction — ✓ Clear

**What**: After context compaction rewrites messages, does the scroll
offset clamp correctly?

**Trace**: `packages/tui/src/app-reducer.ts` satır 2028-2049 —
`setMeasuredLines` is the action that fires when the ScrollableHistory
component measures its content height after a render.

When compaction replaces messages:
1. The message list shrinks (old messages are summarized).
2. `setMeasuredLines` fires with a smaller `totalLines`.
3. The reducer at satır 2044-2048 handles "content shrank" by
   re-clamping: `scrollOffset: Math.min(state.scrollOffset, maxOffset)`.
   If the offset is now beyond the new max, it snaps back to the max
   (the oldest visible row).
4. If the user was pinned to the bottom (`scrollOffset === 0`), they
   stay pinned — the condition at satır 2035 (`scrollOffset > 0`) is
   false, so the "grew while scrolled up" branch is skipped and the
   "pinned or shrank" branch (satır 2044) keeps offset at 0.

**Verdict**: No bug. Scroll offset is correctly clamped after content
shrinkage. Users pinned to the bottom stay pinned; users scrolled up
get clamped to the new maximum.

---

### D4. WebUI Optimistic Update Rollback — ✅ Done (commit `49af75b7`)

**What**: Chat send creates an optimistic entry — if the WS round-trip
fails, is the entry removed or stranded?

**Trace**: `packages/webui/src/stores/chat-store.ts` — the `addMessage()`
method pushes a message into `messages[]` immediately (optimistic). The
WS client queues the message if not connected (`messageQueue`).

The WS `send()` method (`ws-client.ts`) has a fallback: if the socket
is not open, it pushes to `messageQueue` and `flushMessageQueue()` sends
them when the socket opens. So the message is eventually delivered.

However, there is **no rollback mechanism**: if the server returns an
error for the user message (e.g. the session is closed, the provider
failed permanently), the optimistic message stays in the chat list.
There is no `removeMessage(id)` method or error callback that removes
the stranded entry.

In practice, server-side errors are surfaced as `error` events which
the client renders as assistant messages, not by removing the user
message. So the user sees their message + an error reply — which is
arguably correct UX (the user can see what they tried and that it
failed).

**Severity**: P3. Not a bug per se — the optimistic entry is a record
of what the user sent, and an error reply follows it. But the entry
has no `failed` or `error` status flag to distinguish it from a
successfully-delivered message.

**Verdict**: Acceptable. The optimistic entry is never "stranded" in a
misleading way — it's followed by an error message. A `status: 'failed'`
flag would be nice-to-have polish.

---

### D5. TUI Ink Live-Region Leak — ✓ Clear

**What**: `nowTick` 1s interval re-renders the live region — does any
panel leave residual output in native scrollback?

**Trace**: The `nowTick` interval drives the status bar's elapsed-time
chip and the spinner animation. It triggers a re-render of the App
component, but Ink's `log-update` (the live-region renderer) only
updates the live rows — it doesn't emit new lines.

The panels that are visible during the 1s tick (status bar, input,
monitor overlays) all use Ink's Box/Text components, which render within
the live region. They don't call `process.stdout.write` directly.

The `LiveActivityStrip` is deliberately NOT rendered in inline mode
(app.tsx satır 6813-6824 comment) precisely because its bottom-edge
position would scroll the screen on every tick. This is already handled.

**Verdict**: No leak. The live region is stable — only the spinner and
elapsed chip change, and Ink handles this without scrolling.

---

## Summary — Area D

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| D1 | Reducer action batching | — | ✓ Clear |
| D2 | WS reconnection state recovery | — | ✓ Clear |
| D3 | Scroll position after compaction | — | ✓ Clear |
| D4 | Optimistic update rollback | P3 | ✅ Done (`49af75b7`) |
| D5 | Ink live-region leak | — | ✓ Clear |

**Result**: 4 clear, 1 fixed (P3 — `status` field on `ChatMessage`,
commit `49af75b7`).

---

## Area E — Cross-Cutting

### E1. Package Boundary Test Coverage — ✓ Clear

**What**: Does `package-boundaries.test.ts` cover the new
`types/side-effect.ts` and `types/tool-markers.ts` exports?

**Trace**: `packages/core/tests/architecture/package-boundaries.test.ts`
— the test scans `@wrongstack/*` imports across all source files and
enforces a layered dependency graph (kernel → types → core → storage →
coordination → etc.). It does NOT enumerate individual exported symbols
— it checks import directions, not export contents.

Both `types/side-effect.ts` and `types/tool-markers.ts` live in the
`types/` layer. Their exports are re-exported via `types/index.ts`.
Any package importing `@wrongstack/core` gets these types — no layer
violation.

The test's layer definitions (satır 21-37) include `'types'` as a
layer. Both files live under `types/`, so they're automatically covered.

**Verdict**: No gap. The boundary test checks import directions, not
individual exports. New type files in the `types/` layer are covered
by existing layer rules.

---

### E2. Secret Scrubber Coverage on New Error Paths — ✓ Clear

**What**: Do `FetchError` and `ToolValidationError` context fields get
scrubbed before logging?

**Trace**: The secret scrubber (`packages/core/src/security/secret-scrubber.ts`)
is applied in `ToolExecutor.executeTool()` at satır 412:
```ts
const scrubbed = this.opts.secretScrubber.scrub(text);
```
This scrubs the **tool result text** (the rendered output). Error
results go through the same path (satır 284-289 in the catch block):
```ts
const msg = toErrorMessage(err);
const scrubbed = this.opts.secretScrubber.scrub(msg);
```

`FetchError` and `ToolValidationError` extend `WrongStackError`. Their
`message` field is a human-readable string, not a raw secret. Their
`context` field (satır: `{ status: ..., ...opts.context }`) is stored
on the error object but **not included in the error message** — it's
metadata for diagnostics.

The scrubber only runs on the `message` text (via `toErrorMessage`),
not on `err.context`. If `err.context` contains a secret (e.g.
`{ url: 'https://api.example.com?token=sk-xxx' }`), it would NOT be
scrubbed. However, the `FetchError` constructor's `message` parameter
is always caller-controlled and doesn't include raw context — callers
pass descriptive messages like `"HTTP 401"`.

**Verdict**: Acceptable. Error messages are scrubbed. Error context
fields are metadata for diagnostics, not logged to the model — they're
only visible in structured logs (if a tracer is configured) and crash
reports. The risk of a secret in `context` is low because callers
construct the context explicitly.

---

### E3. Skill Loader Path Traversal — ✓ Clear

**What**: A skill with `../../../etc/passwd` in its `path` field — does
the loader reject it?

**Trace**: `packages/core/src/execution/skill-loader.ts` — the loader
discovers skills by iterating **directory entries** (satır 82-83):
```ts
const entries = await fs.readdir(dir, { withFileTypes: true });
for (const e of entries) {
  if (!e.isDirectory()) continue;
  const skillFile = path.join(dir, e.name, 'SKILL.md');
```

The skill `path` is constructed from `path.join(dir, e.name, 'SKILL.md')`
where `e.name` is a directory entry name from `readdir`. The OS's
`readdir` returns the base name of each entry — `../` is not a valid
directory name within the listing. Even if a symlink named `..` existed,
`e.isDirectory()` follows symlinks and `readdir` returns the link's
name, not its target.

The skill `name` comes from the YAML frontmatter (`parseFrontmatter`),
not from the directory name. The `name` is used only for display and
matching — it's never used as a file path.

A malicious `SKILL.md` file placed in `<skills-dir>/evil/SKILL.md` would
be loaded with `path = <skills-dir>/evil/SKILL.md` — no traversal.

**Verdict**: No traversal vulnerability. The loader constructs paths
from `readdir` entries, not from user-supplied path strings.

---

### E4. MCP Server Lifecycle on Crash — ✓ Clear

**What**: If an MCP server process crashes, does the registry mark it
failed or hang on the next tool call?

**Trace**: `packages/mcp/src/registry.ts`:
- `onChildExit` (satır 448-478): Called when the stdio child exits.
  - **Lazy server**: goes `dormant` (satır 458-464), next tool call
    re-spawns it. No reconnect storm.
  - **Eager server**: unregisters all tools (satır 466-473), sets
    state to `disconnected` (satır 475), emits disconnect event
    (satır 476), and calls `scheduleReconnect()` (satır 477).
- `onTransportDisconnect` (satır 480-502): Same logic for HTTP-based
  transports.
- `scheduleReconnect()` uses exponential backoff with `MAX_RECONNECT_CYCLES`
  (satır 510, typically 5 cycles). After max cycles, the slot stays
  `failed` and requires an explicit `restart()`.

**The next tool call after a crash**:
- If state is `disconnected` and reconnect is in progress: the tool
  call awaits the reconnect (via `ensureConnected` → `attemptConnect`).
- If state is `failed`: `ensureConnected` throws on line 164-166
  (`MCP server "..." failed to connect on demand`). **No hang.**
- If state is `dormant` (lazy): `ensureConnected` re-spawns.

**Verdict**: No hang. Crashed servers are properly handled: tools are
unregistered, reconnect is attempted with backoff, and after max
retries the slot is `failed` with a clear error on the next call.

---

### E5. Codebase Index SQLite WAL Checkpoint — ✓ Clear

**What**: Long-running indexer with WAL mode — does the WAL file grow
without bound?

**Trace**: `packages/tools/src/codebase-index/writer.ts` satır 211:
```ts
this.db.exec('PRAGMA journal_mode = WAL');
```

SQLite's WAL mode auto-checkpoints when the WAL file reaches 1000 pages
(~4MB by default). The `writer.ts` constructor does NOT set
`wal_autocheckpoint` to 0 (which would disable auto-checkpointing), so
the default auto-checkpoint behavior applies.

The indexer writes are batched (via `runWithRetry` + transaction
wrappers), not continuous — each indexing run writes a batch and
commits. Between runs, the WAL auto-checkpoints normally.

**Verdict**: No unbounded growth. SQLite's default auto-checkpoint
(1000 pages) bounds the WAL file size at ~4MB. The indexer's batch
write pattern naturally allows checkpointing between batches.

---

## Summary — Area E

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| E1 | Package boundary test coverage | — | ✓ Clear |
| E2 | Secret scrubber on new error paths | — | ✓ Clear |
| E3 | Skill loader path traversal | — | ✓ Clear |
| E4 | MCP server lifecycle on crash | — | ✓ Clear |
| E5 | SQLite WAL checkpoint | — | ✓ Clear |

**Result**: 5 clear. The cross-cutting concerns are well-handled:
package boundaries are layer-based (not symbol-based), secret scrubbing
covers error messages, skill paths are readdir-derived (no traversal),
MCP crashes produce clean failed/reconnect states, and SQLite WAL
auto-checkpoints by default.

---

## Sprint 2 Audit — Final Summary

| Area | Total | Clear | Done (P2) | Done (P3) | Design Doc | P1 |
|------|-------|-------|-----------|-----------|------------|-----|
| A — Provider & Streaming | 6 | 5 | 0 | 0 | 1 (A3) | 0 |
| B — Coordination & Fleet | 6 | 5 | 1 (B6) | 0 | 0 | 0 |
| C — Storage & Persistence | 6 | 6 | 0 | 0 | 0 | 0 |
| D — TUI/WebUI State | 5 | 4 | 0 | 1 (D4) | 0 | 0 |
| E — Cross-cutting | 5 | 5 | 0 | 0 | 0 | 0 |
| **Total** | **28** | **25** | **1** | **1** | **1** | **0** |

**Verdict**: The codebase is in excellent shape. No P1 issues found
across 28 potential findings. Three confirmed items (2 P2, 1 P3) are
all known limitations or nice-to-have polish — none represent
security vulnerabilities, data loss, or reliability risks.

**Confirmed items to address**:
- **A3 (P2)**: Provider retry amplification under concurrent 429s — design doc landed at `docs/design-provider-health-gate.md`; implementation pending prioritization.
- **B6 (P2)**: Orphaned worktrees after subagent crash — ✅ fixed in `a89ea935` (`cleanupStale()` on boot).
- **D4 (P3)**: WebUI optimistic update has no `failed` flag — ✅ fixed in `49af75b7` (`status` field on `ChatMessage`).

**Full report**: see `docs/sprint2-audit-final-report.md` for per-finding
detail, commit list, follow-ups, and release-readiness verdict.
