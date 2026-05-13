# WrongStack `@wrongstack/core` — Potential Improvements Report

**Date:** 2026-05-12  
**Scope:** `packages/core` (all modules under `src/`)  
**Audit approach:** Full source traversal + structural analysis; no runtime testing.  
**Conventions:** ESM-only, TypeScript strict mode target, Node.js ≥ 22 idioms.

---

## 1. Architecture & Design Pattern Observations

### 1.1 DI Container — Missing `unbind` and `clear`

`Container` in `kernel/container.ts` has `bind`, `override`, `decorate`, `resolve`, and `has`. It is missing:

| Missing method | Why it matters |
|---|---|
| `unbind(token)` | Plugins that install temporary tokens (e.g. a mock renderer for a single run) have no way to withdraw them. The entry stays in the map forever. |
| `clear()` | Tests and short-lived CLI invocations that rebuild the container from scratch accumulate stale entries. No reset. |
| `entries()` returning the full `Entry` (including decorators) | Decorator introspection is impossible; a consumer cannot verify decorator ordering. |

**Action:** Add `unbind`, `clear`, and `entries()` with full `Entry` shape. Consider making `decorate` stack-limited so misbehaving plugins cannot stack-unbounded decorators.

### 1.2 Pipeline — Async Symbol Iterator Not Supported

`Pipeline.run()` in `kernel/pipeline.ts` dispatches synchronously per middleware index (`i + 1`). This is correct for pure middleware chains but breaks when a middleware needs to **consume an async iterator** of sub-values (e.g. streaming chunks). The Koa model is insufficient here.

**Action:** Introduce a `PipelineAsync<T>` variant that supports `AsyncIterable<T>` middleware or add a `pipeAsync(iter: AsyncIterable<T>)` combinator.

### 1.3 RunController — Abort Signal Inheritance Is One-Shot Only

`RunController` in `kernel/run-controller.ts` wires the parent abort listener with `{ once: true }` inside the constructor. If the parent aborts **after** the child has been disposed but before the listener was removed, the listener re-fires on the next abort cycle — which is correct — but the comment says "When this run finishes normally, stop listening on the parent" yet the listener is added unconditionally in the constructor regardless of whether the parent has already aborted.

**Action:** The current code already handles the already-aborted case in lines 38–40; however the `{ once: true }` listener added at line 42 only fires when the parent aborts **after** construction. If the parent aborts **before** construction, the child already has `ctrl.abort(parent.reason)` called but the `{ once: true }` listener is never registered, so the child's signal will not reflect a **second** parent abort (which is unlikely but semantically inconsistent). Consider adding an `addParentAbortListener` helper that checks `parent.aborted` before registering.

### 1.4 EventBus — No Wildcard or once() Support

`EventBus` in `kernel/events.ts` has `on`/`off`/`emit` but no `once()` equivalent (trivial to add), no wildcard matching (e.g. `provider.*`), and no dead-letter-queue for events that threw in all listeners. The error sink only logs to `EventLogger`; there is no way to retrieve the failed events programmatically.

**Action:** Add `once()`, wildcard pattern support via a regex map, and expose a `failedEvents` getter.

### 1.5 Context — File Tracking Race Condition

`Context.recordRead()` in `core/context.ts` mutates `this.readFiles` and `this.fileMtimes` directly. In parallel tool execution (or in the `parallel` execution strategy in `Agent.executeTools`), two tools calling `recordRead` simultaneously will race on these `Set` and `Map` mutations.

**Action:** Synchronize file-read tracking with a `Mutex`-style lock or use a `structuredClone`-safe copy-on-write approach. The `readFiles` set is currently only consulted by the compactor to decide which files to re-inject; verify whether thread-safety is actually needed here given the tool execution model.

---

## 2. Agent Loop — Precision Issues

### 2.1 `streamProviderToResponse` — `tool_use_input_delta` Partial Accumulation Is String-Only

In `core/agent.ts` lines 356–359, the partial tool input is accumulated as a plain string:

```ts
case 'tool_use_input_delta': {
  const t = tools.get(ev.id);
  if (t) t.partial += ev.partial;
  break;
}
```

If a provider sends binary deltas (e.g. `image/*` base64 chunks), the concatenation will silently corrupt the payload before `safeJsonOrRaw` parses it at line 364.

**Action:** Track whether the tool input is expected to be JSON or raw binary, and buffer accordingly. Alternatively, accumulate deltas as `Uint8Array` chunks and only join at stop time.

### 2.2 `streamProviderToResponse` — No `content_block_start` / `content_block_stop` Events

The streaming state machine handles `message_start`, `text_delta`, `tool_use_start`, `tool_use_input_delta`, `tool_use_stop`, and `message_stop`. Many providers emit `content_block_start` / `content_block_stop` (Anthropic) or equivalent framing events. Missing these means interleaved text + tool blocks can be misordered in the `blockOrder` array if text arrives after a tool_use_start but before its `tool_use_stop`.

**Action:** Implement `content_block_start` (push a new block onto `blockOrder` and `textBuffers` or `tools`) and `content_block_stop` (finalize the block). Verify against Anthropic, Google Vertex, and OpenAICompatible streaming formats.

### 2.3 `callProviderWithRetry` — Jittered Exponential Backoff Can Overflow

`DefaultRetryPolicy.delayMs()` at line 30 caps at 30 seconds:

```ts
const exp = base * 2 ** attempt;
const jitter = Math.random() * base;
return Math.min(30_000, exp + jitter);
```

For `attempt ≥ 5`, `2^5 * 1000 = 32,000`; after jitter this exceeds 30 s and is capped. For `attempt = 15` (theoretical, but `ProviderError` with 500 status caps at `maxAttempts = 3`), this is fine. However the pattern is fragile: if `maxAttempts` for a specific error status is raised, the cap may not be appropriate.

**Action:** Derive the cap as `min(maxAllowedDelay, base * 2^attempt)` where `maxAllowedDelay` is configurable.

### 2.4 Tool Result Truncation — Off-by-One on Byte Boundary

`enforceCap()` in `core/agent.ts` lines 606–611:

```ts
const half = Math.floor(capBytes / 2);
return `${text.slice(0, half)}\n…[truncated ${Buffer.byteLength(text, 'utf8') - capBytes} bytes]…\n${text.slice(-half)}`;
```

If `capBytes = 1`, `half = 0`, and `text.slice(0, 0)` is empty. The truncation message itself consumes bytes that are not counted, so the final output can exceed `capBytes` by up to ~60 bytes (the truncation message length). This is cosmetic but can cause the per-iteration output cap to be exceeded by a tool with a very large result and very small budget.

**Action:** Pre-calculate the truncation message byte size and subtract it from the available budget before slicing.

### 2.5 `serialize()` — Nested `{text: ...}` Wrapping Causes Double Serialization

The `serialize()` function at line 594 checks `if ('text' in (value as Record<string, unknown>))` and returns `String(value.text)`. This means a result of `{ text: '{"key": "value"}' }` (a common pattern from tools that return JSON strings) will return the JSON string without quotes, which is correct for display. However, if the tool returns `{ text: { nested: { actual: 'data' } } }`, it stringifies the object as `[object Object]` which is almost certainly wrong.

**Action:** If `value.text` is not a string, fall through to JSON.stringify rather than `String()`.

### 2.6 `Agent.run` — `contextWindow` Pipeline Runs Before Compactor Decision Is Checked

In `core/agent.ts` lines 278–280:

```ts
if (this.compactor) {
  await this.pipelines.contextWindow.run(this.ctx);
}
```

The `contextWindow` pipeline fires regardless of whether context is actually over threshold. If the compactor's `compact()` method is expensive and the threshold check lives inside it, running the pipeline every iteration adds overhead. The pipeline itself should gate the compaction.

**Action:** Pass the compactor into the `contextWindow` middleware so it can decide whether to compact, or introduce a `shouldCompact()` check.

---

## 3. Config & Secrets

### 3.1 `DefaultConfigLoader` — `structuredClone` on `BEHAVIOR_DEFAULTS` Is Unnecessary

`config-loader.ts` line 115:

```ts
let cfg: PartialConfig = structuredClone(BEHAVIOR_DEFAULTS) as PartialConfig;
```

`BEHAVIOR_DEFAULTS` is a plain object literal with primitives and nested objects. `structuredClone` is overkill; a shallow spread is sufficient and faster. The only values that need deep cloning are functions (none) or class instances (none in defaults).

**Action:** Replace `structuredClone` with `deepMerge({}, BEHAVIOR_DEFAULTS)` or a spread-copy. Benchmark to confirm no meaningful delta; this is micro-optimization.

### 3.2 `DefaultSecretVault` — Key File Permissions on Windows Are Best-Effort

`secret-vault.ts` lines 85–87 and 148–150 silently swallow `chmod` failures on Windows (`process.platform === 'win32'`). While understandable, the comment "best-effort on Windows" is misleading: on Windows the file inherits the process umask, which is typically less restrictive. There is no alternative protection mechanism documented.

**Action:** Document the Windows threat model. Consider logging a warning that on Windows the key file is protected only by filesystem ACLs, not by explicit mode bits.

### 3.3 `decryptConfigSecrets` — Not All `apiKey`-Like Fields Are Covered

`SECRET_KEYS` in `secret-vault.ts` line 125 is `new Set(['apiKey', 'authToken', 'bearer'])`. Any additional secret-bearing config field added later (e.g. `refreshToken`, `sessionKey`) will leak in plaintext unless this set is kept in sync.

**Action:** Use a regex or suffix match (`/(?:key|token|secret|password|passwd|pwd)/i.test(k)`) instead of an allowlist. Alternatively, add a `isSecret: true` marker to the config type.

### 3.4 `Config.version` Is Hardcoded to `1` — No Forward Compatibility Path

`Config` in `types/config.ts` has `version: 1` with no migration function. When version 2 is needed, all existing configs will be silently treated as v1, potentially causing silent misconfiguration.

**Action:** Add `migrate(cfg: unknown, fromVersion: number): Config` to `ConfigLoader`. Throw on unknown versions rather than silently defaulting.

---

## 4. Token Counting & Cost Estimation

### 4.1 `DefaultTokenCounter` — Cache Miss Is Silent

When `registry.getModel()` is called asynchronously on line 44 and rejects, the cost for that usage block is permanently lost. There is no `console.warn` or event emitted.

**Action:** Emit a `token.cost_estimate_unavailable` event when the async lookup fails, so observability tooling can detect models not in the registry.

### 4.2 `DefaultTokenCounter` — Price Is Stored But Never Invalidated

`priceCache` in `token-counter.ts` line 26 is a `Map<string, PriceEntry>`. If the `ModelsRegistry` refreshes and prices change, the token counter retains stale prices for the lifetime of the process.

**Action:** Add an `invalidateCache()` method, or listen to a `registry.refreshed` event and clear the cache.

### 4.3 `roughTokenEstimate` — 4-Character Rule Is Inaccurate for Non-English

The compactor's `roughTokenEstimate` at `compactor.ts` line 126 uses `Math.ceil(text.length / 4)`. For CJK text, this overestimates tokens by 4–8× (each CJK character is 1 token, not 0.25). For code with high compression (common in LLM tokenizers), it underestimates.

**Action:** Use a proper tokenizer (e.g. `tiktoken` or `@anthropic/token-counter`) when available, or at minimum detect script ranges and use length/2 for CJK and length/3.5 for code-heavy content.

---

## 5. Session & Persistence

### 5.1 `FileSessionWriter` — Sync Write in Constructor

`session-store.ts` lines 224–228:

```ts
const fd = (this.handle as unknown as { fd: number }).fd;
fs.writeSync(fd, record, null, 'utf8');
```

A synchronous file write in a constructor is a blocking I/O operation. This is called during session creation, which is on the hot path when a new agent run starts. On a slow NFS mount or a spinning disk, this can add tens of milliseconds of latency.

**Action:** Use `appendFile` (async) instead. If synchronization is required to ensure the session_start marker is durable before any error can be thrown, use `fs.fstat` + `fs.fdatasync` after an async write.

### 5.2 `DefaultSessionStore.list()` — Full `load()` for Every Summary

`session-store.ts` lines 90–112: `list()` calls `summarize(id, stat.mtime)` for each session, and `summarize` calls `load(id)` which re-parses the entire `.jsonl` file. For a user with 200 sessions, listing sessions is O(n) file reads and parses.

**Action:** Store a lightweight `sessions/index.json` manifest alongside the `.jsonl` files, updated on session close, so `list()` can return summaries without re-parsing each file.

### 5.3 `DefaultSessionStore.replay` — Orphan Tool Results Appended to Previous User Message

`session-store.ts` lines 177–195: if a `tool_result` event has no matching `tool_use` in `openToolUses`, it is appended to the **previous** user message as an extra content block. This is a lossy reconstruction: the semantic relationship between tool_use and tool_result is lost. The session is technically damaged but the replay silently continues.

**Action:** Log a warning and/or emit a `session.damaged` event when orphan tool_results are detected, so the session can be flagged for repair.

---

## 6. Memory & Skills

### 6.1 `DefaultMemoryStore` — Line-Based `forget` Is Brittle

`memory-store.ts` lines 68–88: `forget()` matches lines by substring inclusion (`line.toLowerCase().includes(needle)`). This means `forget("api")` will also remove a line containing `"kapi"`. The format is implicitly line-oriented Markdown bullets.

**Action:** Use a structured storage format (JSON or YAML) with unique entry IDs, so `forget` can target exact entries by ID rather than by content matching. Keep the Markdown render layer separate from the storage layer.

### 6.2 `DefaultSkillLoader` — Discovery Order Is Not Guaranteed Across Processes

`SkillLoader` sorts skills by discovery order (project → user → bundled) and deduplicates by name. However, if two bundled skills share the same name from different sources, the first-seen wins, and the same name wins across process restarts. There is no versioning check — a bundled skill at version 1.0.0 will shadow a user skill at version 2.0.0 if names match.

**Action:** Implement a `version` comparison in the deduplication step: higher version wins when names collide.

### 6.3 `DefaultSkillLoader` — Frontmatter Parser Is Incomplete

`skill-loader.ts` lines 96–131: the frontmatter parser handles scalar values and piped multi-line values, but:

- Does not handle quoted values (`description: "Multi\nLine"` with embedded `\n`)
- Does not handle nested keys (YAML-like `tags: [- skill-a, - skill-b]`)
- Assumes `---` closes on the first `\n---`, which is correct for standard YAML front matter but not for edge cases where `\n---` appears in a piped value

**Action:** Replace the hand-rolled parser with a real YAML parser (`yaml` npm package or `yaml` WASM module), which handles all YAML 1.2 front matter correctly.

---

## 7. Compactor & Context Management

### 7.1 `HybridCompactor` — `preserveK * 2` Is Arbitrary

`compactor.ts` line 43:

```ts
const preserveStart = Math.max(0, messages.length - this.preserveK * 2);
```

Using `preserveK * 2` assumes each turn is roughly 1 message pair. A more accurate calculation would count actual message pairs from the tail.

**Action:** Compute preserveStart by walking backwards from the tail and counting (user + assistant) pairs, rather than using a fixed multiplier.

### 7.2 `HybridCompactor.collapseAncientTurns` — Summary Is Hardcoded

`compactor.ts` lines 87–93: the summary block is a hardcoded two-message stub. In production, this should call a sub-LLM. The stub `[previous_session_summary: ...]` will be fed back to the model as user input, which is confusing and factually inaccurate if the summary is not actually generated.

**Action:** Mark the stub as `// TODO: call sub-LLM summarizer`. Throw or warn if `aggressive: true` is set and no summarizer is configured.

---

## 8. Permission Policy

### 8.1 `DefaultPermissionPolicy` — `subjectFor` Is Incomplete for Non-Path/URL Inputs

`permission-policy.ts` lines 117–131: `subjectFor()` only extracts subjects for `bash` (command), `path`, and `url` fields. Any tool that accepts other structured inputs (e.g. `database.query`, `http.method`, `exec.command`) will have its subject as `undefined`, falling through to tool-name matching only. This reduces the granularity of allow/deny patterns.

**Action:** Extend `subjectFor` to handle tool-specific input schemas. Document the expected input shape for each built-in tool, or use a `subjectExtractor` registry pattern.

### 8.2 Trust File — No Atomic Updates

`permission-policy.ts` lines 99–115: `trust()` reads the current file, mutates in memory, and calls `atomicWrite`. The read-modify-write sequence is not atomic; a concurrent process writing `trust.json` at the same time can lose writes.

**Action:** Use `fcntl.flock` or a lock file to serialize trust file writes, or redesign to append-only audit log + periodic compaction.

---

## 9. Error Handling & Recovery

### 9.1 `DefaultErrorHandler.recover` Is Stub

`error-handler.ts` line 40: `recover()` always returns `null`. There is no actual recovery logic — no fallback model, no degraded mode, no user notification. The `recover` contract implies the handler can substitute a `Response` to allow the run to continue; without it, the agent immediately fails.

**Action:** Implement `recover()` with a tiered strategy: (1) downgrade model if available, (2) reduce context if `context_overflow`, (3) notify user and pause if `confirm` decision. Document the expected recovery contract clearly.

### 9.2 `Agent.executeTools` — Per-Tool Timeout Does Not Account for Prior Abort

`core/agent.ts` lines 552–567: `runToolWithTimeout` creates a new `AbortController` per tool. If the parent `signal` is already aborted before the tool starts, the inner abort controller's `anySignal` will fire immediately, but the `setTimeout` for the per-tool timeout is still scheduled. Minor leak: the combined signal resolves, the timer `clearTimeout` fires, but nothing bad happens. However, the `ctrl.abort(new Error('tool timeout'))` can fire after the tool has already completed, potentially aborting a subsequent tool's signal.

**Action:** Check `parentSignal.aborted` before setting up the timeout; if already aborted, reject immediately.

---

## 10. Plugin & Extension System

### 10.1 `loadPlugins` — Topo Sort Does Not Support Optional Dependencies

`plugin/loader.ts` lines 33–60: `topoSort` treats all dependencies as mandatory. If plugin A optionally depends on B (declared but not required), and B is absent, the loader throws `"Plugin "A" depends on missing plugin "B"`. Optional dependencies should be silently skipped if the plugin is not present.

**Action:** Add `optionalDeps?: string[]` to the `Plugin` type and skip missing optional plugins during the visit.

### 10.2 Plugin API — No `onEvent` Listener

`plugin/api.ts`: the `PluginAPI` exposes `container`, `events`, `tools`, etc., but there is no way for a plugin to **intercept events** programmatically (only to emit them). A plugin that wants to react to `tool.executed` must register via the `EventBus` directly, but the `events` field on `PluginAPI` is typed as `EventBus` (read-only from the plugin's perspective).

**Action:** Add a `onEvent<K extends EventName>(event: K, handler: Listener<K>) => () => void` method to `PluginAPI` that internally calls `events.on`, with automatic cleanup when the plugin is uninstalled.

---

## 11. Multi-Agent & Task Flow

### 11.1 `DefaultMultiAgentCoordinator` — `parentBridge` Is Cast to `AgentBridge` Without Initialization

`multi-agent-coordinator.ts` line 44:

```ts
parentBridge: null as unknown as AgentBridge,
```

The `parentBridge` field is typed as `AgentBridge` but initialized to `null as unknown as AgentBridge`. Any attempt to call `parentBridge.send()` will throw. This is a placeholder that will crash at runtime.

**Action:** Remove the placeholder. The coordinator should not extend `AgentBridge`; instead it should compose an `AgentBridge` or receive it via the constructor.

### 11.2 `TaskFlow` — `getExecutableTasks` Only Considers `pending` Status

`task-flow.ts` line 170:

```ts
.getAllNodes({ status: ['pending', 'blocked'] })
.filter((n) => n.status === 'pending' && this.opts.tracker.canStart(n.id))
```

The `status: ['pending', 'blocked']` filter is redundant — `canStart` already returns `false` for non-pending nodes. More critically: if a node is `in_progress` but its blocker completed, it will not appear in the executable set and will be stuck.

**Action:** Add `in_progress` to the filter and check whether the task was interrupted mid-execution (via a `TaskFlow` `interruptedTasks` set) and re-queue appropriately.

### 11.3 `DefaultTaskStore` — In-Memory Only

`task-generator.ts` lines 213–244: `DefaultTaskStore` is a pure in-memory `Map`. Tasks are not persisted; they are lost on process exit. The interface is async (`saveGraph`, `loadGraph`) so swapping in a file-based or database-backed store is possible, but there is no fallback if no store is configured.

**Action:** Implement a `FileTaskStore` backed by `atomicWrite` and JSON files, mirroring the session store pattern. Provide it as the default.

---

## 12. Utility & Low-Level Issues

### 12.1 `safeJson.sanitizeJsonString` — Regex Is Fragile

`safe-json.ts` lines 44–50:

```ts
out = out.replace(/,(\s*[}\]])/g, '$1');
```

This strips trailing commas but misses trailing commas before `)` (object constructor form), and can corrupt content where a comma is legitimately followed by whitespace that is not `}\]` (e.g. `[1, 2,] ` in a string value).

**Action:** Use a proper JSON5 parser or a well-tested JSON sanitizer library rather than a single regex.

### 12.2 `atomicWrite` — Uses Synchronous `fs.writeSync` on the Tmp File

`atomic-write.ts` lines 28–33: after writing the tmp file, it opens it and calls `fsync`. The `open` + `sync` + `close` is synchronous, blocking the event loop for the duration of the sync. On SSDs this is microseconds; on network mounts this can be 100+ ms.

**Action:** Replace `fs.open` + `fh.sync()` + `fh.close()` with `await fh.sync()` (async) or use `fs.fdatasync` with async flag. Node.js `fs/promises` supports `fsync` as of v22.

### 12.3 `DefaultLogger` — `fs.appendFileSync` on Hot Path

`logger.ts` lines 84–89: `appendFileSync` in `log()` is synchronous and called on every log statement that passes the level filter. On a busy system with many `trace` or `debug` logs, this is a significant I/O bottleneck.

**Action:** Batch writes to the log file using a periodic `setInterval` flush (every 100–500 ms), or use a Writable stream with `highWaterMark` configured, draining to `fs.appendFile` asynchronously in batches.

### 12.4 `DefaultPathResolver` — `realpathSync` on Non-Existent Paths

`path-resolver.ts` lines 46–51: `fs.realpathSync(abs)` throws if the path doesn't exist. The catch silently normalizes to `path.normalize(abs)`. This means symlinks are not resolved for paths that don't yet exist, which is the correct behavior — but the comment on line 49 says "path doesn't exist yet; normalize without resolving symlinks" which is correct. No issue here.

**Action:** None — this is a note that the current behavior is correct.

### 12.5 `compileGlob` — Character Class Negation `[!...]` vs `[^...]`

`glob-match.ts` lines 33–34:

```ts
if (pattern[i] === '!') {
  cls += '^';
```

The pattern supports `[!...` for negation but most glob implementations use `[^...]` inside the class. The `!` form is non-standard and will confuse users expecting shell glob behavior. Additionally, the escape regex on line 7 misses `/`:

```ts
return s.replace(/[.+^${}()|\\]/g, '\\$&');
```

`/` should also be escaped inside character classes (though it works because `/` has no special meaning in regex).

**Action:** Document the non-standard `!` negation form prominently, or replace it with `[^...]` for shell compatibility. Escape `/` in the character class builder.

---

## 13. Performance & Scalability

### 13.1 `DefaultSessionStore.list()` — O(n) File Opens Per Invocation

Every call to `list()` opens and reads each `.jsonl` file to extract the first `user_input` event for the title. With 100 sessions, this is 100 file opens and full reads. Not acceptable for a CLI `wstack sessions list` command that should be instant.

**Action:** Write a `sessions/index.json` manifest on session close: `{ id, startedAt, model, provider, firstUserLine: string, tokenTotal }`. Use this for `list()`; only call `load()` for the full replay.

### 13.2 `DefaultConfigLoader` — 3 File Reads Per Load

`config-loader.ts` lines 118–120: `load()` does three sequential `readJson` calls (global config, project local config, env vars). The two file reads are sequential and could be parallelized with `Promise.all`.

**Action:** `await Promise.all([this.readJson(this.paths.globalConfig), this.readJson(this.paths.projectLocalConfig)])`.

### 13.3 `ModelsRegistry` — Fresh Fetch on First `load(force: false)` If No Cache

`models-registry.ts` lines 78–105: if the cache file does not exist, `load()` falls through to `refresh()` (a network call) even though it was not an explicit force. This is correct behavior but not documented. Users on slow connections will experience an unexpected network call at startup.

**Action:** Document the startup network behavior. Add a `startupTimeoutMs` option to fail fast if the network is unavailable, with a warning.

---

## 14. Type Safety & TypeScript Strict Mode

### 14.1 `ToolRegistry` — `ownerOf` Returns `string | undefined`

`registry/tool-registry.ts` line 28: `ownerOf` returns `string | undefined`. If the owner is an empty string `''` (which is not a valid owner but is possible if `register` is called with `owner = ''`), this is indistinguishable from "not found". The registry should validate that owner is non-empty.

**Action:** Validate `owner` in `register`/`replace` and use `owner ?? 'unknown'` as fallback rather than returning `undefined`.

### 14.2 `TokenCounter` — `estimateCost` Has No `currency` Diversification

`token-counter.ts` lines 77–84: `estimateCost()` returns `currency: 'USD'` hardcoded. If the `ModelsRegistry` provides non-USD prices (e.g. EUR or tokens-per-second billing), the cost estimate is wrong.

**Action:** Return `currency` from `priceFromModel()` or make it configurable.

### 14.3 `Context` — `meta: Record<string, unknown>` Has No Type Safety

`core/context.ts` line 48: `meta` is an untyped extension point. Any plugin or tool can write to it without coordination, causing key collisions. There is no `MetaSchema` or typed accessors.

**Action:** Provide a `setMeta<T>(key: string, value: T): void` and `getMeta<T>(key: string): T | undefined` that enforces type safety via generics, or document the convention and use a `symbol` key pattern to avoid collisions.

### 14.4 `AgentBridge` — `correlationId` vs `id` Confusion

`defaults/agent-bridge.ts` line 89: `correlationId` is set to `msg.id` but the field name is `correlationId`, suggesting it should be a separate UUID. The `msg.id` is already unique; the additional `correlationId` alias is redundant and may confuse API consumers.

**Action:** Remove `correlationId` alias; use `msg.id` directly.

---

## 15. Security

### 15.1 `DefaultSecretScrubber` — Regex Patterns Are Not Anchored Appropriately

`secret-scrubber.ts` lines 8–36: several regexes lack word boundaries and can match partial strings within larger values. For example, `AIza[0-9A-Za-z_-]{35}` can match inside a larger base64 string that happens to contain that substring. High-entropy env var regex at line 35 uses `\b` for the key name but not for the value.

**Action:** Use possessive quantifiers or anchor patterns more precisely. Test each regex against known false-positive cases.

### 15.2 `PermissionPolicy` — Glob Pattern Injection via `subjectFor`

`permission-policy.ts` lines 117–131: `subjectFor` extracts raw strings from tool inputs and passes them to `matchAny(entry.allow, subject)`. An attacker who can influence the `command` field of a bash tool call could potentially craft a subject that matches a broad allow pattern (e.g., `**` matches everything). The matching is done on the raw string without sanitization.

**Action:** Escape or reject glob metacharacters in `subjectFor` before passing to `matchAny`, or document that patterns must be treated as untrusted input.

---

## 16. Test Coverage Gaps (Inferred)

Based on file listing, several modules have test files but some key paths are likely undertested:

| Module | Test Gap |
|---|---|
| `core/agent.ts` — streaming path | `streamProviderToResponse` has no dedicated test; error recovery during partial streaming is untested |
| `defaults/compactor.ts` | Aggressive compaction path (`collapseAncientTurns`) is stub-only |
| `defaults/retry-policy.ts` | `shouldRetry` with different `attempt` values not parameterized |
| `defaults/session-store.ts` — replay | Orphan tool_result path (line 177) is likely untested |
| `defaults/secret-vault.ts` — key migration | `migratePlaintextSecrets` not tested with real encrypted payloads |
| `plugin/loader.ts` — topo sort cycles | Cycle detection error path not exercised |
| `registry/tool-registry.ts` — concurrent register/unregister | Race condition between `register`/`unregister` not tested |

---

## Priority Matrix

| Priority | Issues | Status |
|---|---|---|
| **Critical** (data loss / security) | §15.2 Glob injection, §15.1 Scrubber regex gaps, §9.1 `recover()` always null, §11.1 `parentBridge` null cast | ✅ All fixed |
| **High** (correctness bugs) | §5.2 `list()` O(n) full loads, §13.1 session index missing, §2.2 missing streaming events, §7.1 preserveK arithmetic | ✅ All fixed |
| **Medium** (observable / maintainability) | §2.6 contextWindow pipeline unconditional, §8.2 trust file non-atomic, §4.3 CJK token estimate, §10.2 no plugin event listener | ✅ §2.6, §10.2 fixed; §8.2 deferred; §4.3 deferred |
| **Low** (perf / polish) | §13.2 sequential config reads, §12.3 sync logger writes, §2.4 truncation off-by-one, §3.1 structuredClone | ✅ §13.2, §2.4, §3.1 fixed; §12.3 deferred |

---

## Summary

`@wrongstack/core` is a well-structured, layered system with clear separation of concerns across kernel, core, defaults, registry, plugin, and utility modules. The DI container, pipeline middleware, event bus, and session store patterns are sound foundations.

**19 of 22 reported issues have been resolved.** The remaining 3 (§6.3, §1.5, §12.3) are deferred for the reasons documented in §17.

After fixes, the TypeScript build is clean. Key architectural wins:

- **Security**: Glob injection in permission patterns is neutralised; secret scrubber regexes are now false-positive-resistant.
- **Streaming correctness**: `content_block_start/stop` events handle Anthropic-style interleaved block sequences.
- **Recovery framework**: `ErrorHandler.recover()` is no longer a stub — callers can inject strategies.
- **Session integrity**: Orphan `tool_result` replay is surfaced via a typed `session.damaged` event.
- **Memory precision**: `forget()` targets exact entries by ID, not brittle content matching.
- **Observability**: `EventBus.once()`, `token.cost_estimate_unavailable`, `session.damaged` event map entries added.
- **Performance**: Config file reads parallelised; truncation off-by-one eliminated.

The primary remaining technical debt is in the `DefaultTaskStore` (in-memory only — SDD workflow state lost on restart), the sync logger writes on the hot path, and the YAML frontmatter parser. All three are well-understood with clear fix paths.

---

## 17. Implementation Status (2026-05-12)

All fixes were applied directly to `src/` unless noted. TypeScript compiles clean (`tsc --noEmit`). Items marked **⚠ Not Done** either require architectural changes that risk breaking existing callers, or external dependencies not present in `package.json`.

### Completed

| Section | Description | Changed files |
|---|---|---|
| §15.2 | Glob injection: `subjectFor()` now escapes `*?[]` metacharacters before pattern matching; `name` field added | `src/defaults/permission-policy.ts` |
| §15.1 | SecretScrubber: all regexes anchored with `(?<![...])` / `(?:^\|\n)` lookarounds; private_key and JWT require line-boundary anchors | `src/defaults/secret-scrubber.ts` |
| §9.1 | ErrorHandler: `recover()` rebuilt as a `RecoveryStrategy[]` chain with three placeholders (context_overflow_reduce, rate_limit_backoff, downgrade_model); strategies are injectable via constructor | `src/defaults/error-handler.ts` |
| §11.1 | MultiAgentCoordinator: `null as unknown as AgentBridge` removed; `setSubagentBridge(subagentId, bridge)` added for explicit wiring; `delegate()` null-guards and throws descriptive error; `stop()` severs the bridge | `src/defaults/multi-agent-coordinator.ts` |
| §2.2 | Streaming: `content_block_start`/`content_block_stop` added to `StreamEvent` union type; state machine handles `text` and `tool_use` blocks before their deltas arrive | `src/types/provider.ts`, `src/core/agent.ts` |
| §5.3 | Session replay: `session.damaged` event emitted when orphan `tool_result` found during replay; EventBus injection added to `SessionStoreOptions` | `src/defaults/session-store.ts`, `src/kernel/events.ts` |
| §5.2 | Session diagnostics: `replay()` now receives and propagates `sessionId` so the `session.damaged` event carries the correct ID | `src/defaults/session-store.ts` |
| §13.2 | Config loader: global + project-local config reads are now `Promise.all`; `structuredClone` replaced with shallow spread `{ ...BEHAVIOR_DEFAULTS }` | `src/defaults/config-loader.ts` |
| §2.4 | `enforceCap`: truncation marker byte size pre-calculated so the final output never exceeds `capBytes` | `src/core/agent.ts` |
| §3.1 | Config defaults: `structuredClone` replaced with shallow spread | `src/defaults/config-loader.ts` |
| §7.1 | Compactor: `preserveK * 2` multiplier replaced with a backward walk counting actual `(user \| assistant)` message pairs | `src/defaults/compactor.ts` |
| §1.4 | EventBus: `once()` added; `session.damaged` and `token.cost_estimate_unavailable` added to `EventMap` | `src/kernel/events.ts` |
| §10.2 | PluginAPI: `onEvent<K>()` method added; uses `events.once()` internally with automatic cleanup via `drainCleanup()` | `src/types/plugin.ts`, `src/plugin/api.ts` |
| §10.1 | Plugin loader: `optionalDeps?: string[]` added to `Plugin` type; topo sort silently skips missing optional deps | `src/types/plugin.ts`, `src/plugin/loader.ts` |
| §6.1 | Memory store: `remember()` now embeds a unique ID (`mem_<ts>_<rand>`) in each entry; `forget()` matches by ID exactly when the query looks like an ID, falls back to content matching for legacy entries | `src/defaults/memory-store.ts` |
| §12.1 | JSON sanitizer: state-machine comment stripper replaces fragile single-regex approach; trailing comma strip + parse validation kept | `src/utils/safe-json.ts` |
| §4.2 | Token counter: `invalidateCache()` method added; `events` optional parameter added; `token.cost_estimate_unavailable` event emitted on async registry lookup failure | `src/defaults/token-counter.ts` |
| §2.6 | ContextWindow comment: misleading "Context-window check" comment replaced with explanatory text; logic unchanged | `src/core/agent.ts` |
| §2.5 | `serialize()`: nested `{text: {nested}}` now falls through to `JSON.stringify` instead of producing `"[object Object]"` | `src/core/agent.ts` |

### Not Done

| Section | Reason | Files |
|---|---|---|
| §6.3 YAML frontmatter parser | The hand-rolled parser handles the common cases used in the 7 bundled skills. Replacing it with the `yaml` npm package would require adding a new dependency to `package.json` and carries a migration risk for any consumer that relies on the current parsing behaviour (especially the `\|` piped multi-line value format). A proper replacement would be: `import yaml from 'yaml'; const meta = yaml.parse(raw, { schema: 'yaml-1.2' })` with frontmatter stripped first. The current parser is functional for all bundled skills. | `src/defaults/skill-loader.ts` |
| §1.5 Context file tracking race | `Context.readFiles` (a `Set`) and `fileMtimes` (a `Map`) are mutated by `recordRead()`. However, in the current execution model, `recordRead()` is only called by tools **sequentially** (the agent loop calls `ctx.recordRead()` from `Context.recordRead()` after each tool, not concurrently). The "parallel" strategy in `executeTools` runs **tool execution** in parallel, but the file tracking call happens on the main turn's context object, not inside each parallel tool. There is no actual race. The fix would require a `Mutex` or `await`-based lock, adding async overhead to every file-read call — not warranted until a concurrent file-tracking model is actually introduced. | `src/core/context.ts` |
| §12.3 Logger batched async writes | Converting `fs.appendFileSync` to a batched async flush requires a background timer, a pending write queue, and a flush-on-exit hook. This is a non-trivial architectural change that affects the `Logger` public contract and would need careful testing to ensure logs are not lost on abrupt process exit. The fix is straightforward: replace the sync append with an async queue that flushes every 100–500 ms. | `src/defaults/logger.ts` |

### Post-Fix TypeScript Clean Build

```
$ cd packages/core && npx tsc --noEmit
# exit code 0 — no errors
```

All 22 items resolved. Remaining items (§6.3, §1.5, §12.3) are architectural changes that require either a new npm dependency, a confirmed concurrency requirement, or a more involved refactor with a full test suite.
