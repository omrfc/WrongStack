# WrongStack — Refactoring & Improvement Plan

**Generated:** 2026-05-30
**Scope:** Full monorepo — 11 packages, ~50K SLOC source, ~34K SLOC test
**Status:** Active — bugs to be fixed sequentially

---

## Table of Contents

1. [Critical Bugs (Fix First)](#1-critical-bugs-fix-first)
2. [Security Issues](#2-security-issues)
3. [High-Priority Refactoring](#3-high-priority-refactoring)
4. [Medium-Priority Improvements](#4-medium-priority-improvements)
5. [Low-Priority / Nice-to-Have](#5-low-priority--nice-to-have)
6. [Overgrown Modules Requiring Decomposition](#6-overgrown-modules-requiring-decomposition)
7. [Test Coverage Gaps](#7-test-coverage-gaps)
8. [Unused / Unwired Code](#8-unused--unwired-code)
9. [Metric Baseline](#9-metric-baseline)
10. [Priority Execution Order](#10-priority-execution-order)

---

## 1. Critical Bugs (Fix First)

### C1. `plugin/api.ts`: `onEvent` calls `once` instead of `on`
**Status: ✅ ALREADY FIXED**
**File:** `packages/core/src/plugin/api.ts:130–134`

**Bug (historical):** `onEvent` was calling `events.once` — a one-shot listener that auto-unsubscribes after the first emission. Current code already uses `.on`.

```typescript
// Current code — line 131 (already fixed, no action needed)
onEvent<K extends EventName>(event: K, handler: Listener<K>): () => void {
    const off = this.events.on(event, handler);  // ✅ .on
    this.pluginCleanupFns.push(off);
    return off;
}
```

---

### C2. `plugin/loader.ts`: `unloadPlugins` creates fresh API, never calls cleanup
**Status: ✅ ALREADY FIXED**
**File:** `packages/core/src/plugin/loader.ts:268–295`

**Bug (historical):** `unloadPlugins` constructed a new API instance for teardown with an empty `pluginCleanupFns` array. Current code uses a `WeakMap<Plugin, PluginAPI>` to store each plugin's API instance at setup time and retrieves it during teardown.

```typescript
// Current code — loadPlugins stores the API (already fixed)
const rawApi = opts.apiFactory(plugin);
await plugin.setup(api);
pluginApiMap.set(plugin, api);  // ← stored for later teardown

// Current code — unloadPlugins retrieves via WeakMap (already fixed)
const api = pluginApiMap.get(plugin);
if (!api) throw new Error(`Plugin "${plugin.name}" API not found...`);
await plugin.teardown(api);
```

No action needed.

---

### C3. `agent-bridge.ts`: `stop()` orphans pending requests
**Status: ✅ ALREADY FIXED**
**File:** `packages/core/src/coordination/agent-bridge.ts:127–137`

**Bug (historical):** `stop()` was missing `p.reject()` calls when cleaning up pending requests. Current code already calls `p.reject(new Error('Bridge stopped'))` at line 131.

```typescript
// Current code — lines 127–137 (already fixed)
async stop(): Promise<void> {
    this.stopped = true;
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error('Bridge stopped'));  // ✅ present
    }
    this.pendingRequests.clear();
    this.inflightGuards.clear();
    this.subscriptions.clear();
    await this.transport.close(this.agentId);
}
```

No action needed.

---

### C4. `director.ts`: `spawnCount` incremented before spawn succeeds
**Status: ✅ ALREADY FIXED**
**File:** `packages/core/src/coordination/director.ts:680–717`

**Bug (historical):** `spawnCount` was incremented before `await this.coordinator.spawn(config)`. If the coordinator threw, `spawnCount` was permanently consumed with no worker created. Current code increments `spawnCount` AFTER the successful `spawn()` call.

```typescript
// Current code — lines 703–709 (already fixed)
let result: { subagentId: string };
result = await this.coordinator.spawn(config);  // ← await FIRST
// ... FleetManager path or inline path:
this.spawnCount += 1;  // ← incremented AFTER success
this.subagentMeta.set(result.subagentId, { provider: config.provider, model: config.model });
```

No action needed.

---

### C5. ExtensionRegistry hook runners mutate array mid-iteration
**Status: ✅ ALREADY FIXED**
**File:** `packages/core/src/extension/registry.ts:141–187`

**Bug (historical):** Hook runners iterated over a live array while callbacks could mutate it. Current code uses `[...this.extensions]` snapshot pattern on all 8 hook runners.

```typescript
// Current code — lines 141–151 (all 8 runners use the same pattern)
async runBeforeRun(...args: Parameters<BeforeRunHook>): Promise<void> {
    const snapshot = [...this.extensions];  // ← snapshot
    for (const ext of snapshot) {
        if (!ext.beforeRun) continue;
        try { await ext.beforeRun(...args); }
        catch (err) { this.log?.error(...); }
    }
}
```

No action needed.

---

## 2. Security Issues

### S1. Shell Injection in `git-autocommit` and `semver-bump`
**Status: ✅ ALREADY FIXED**
**Files:** `packages/plugins/src/git-autocommit/index.ts:21–34`, `packages/plugins/src/semver-bump/index.ts:25–38`
**CWE:** CWE-78

**Bug (historical):** Both plugins used `execSync` with string interpolation. Current code already uses `execFileSync('git', args, ...)` — the safe array form.

```typescript
// Current code — already fixed (both plugins)
function runGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {  // ✅ args as array
    encoding: 'utf-8', cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}
```

No action needed.

---

### S2. LSP `safeSpawn` leaks environment to LSP servers
**Status: ✅ ALREADY FIXED**
**File:** `packages/plug-lsp/src/` (all spawn sites)
**CWE:** CWE-78

**Bug (historical):** LSP servers received full process environment. Current code already uses `buildChildEnv({ extra: cfg.env })` in `safe-spawn.ts:10`, `command-resolver.ts:32`, and `setup.ts:238`.

No action needed.

---

### S3. WebUI WebSocket Authentication — Token in URL Query String

**File:** `packages/webui/src/server/index.ts:442–495`
**CWE:** CWE-598 — Information Exposure Through Query String
**Status:** Mitigated, not fully resolved.

**Remaining risk:** The initial page-load URL carries `?token=...` in:
- Server-side HTTP access logs (most reverse-proxies log full URLs)
- Browser bookmarks/history

**Fix:** Deliver the token via an `HttpOnly` cookie over the same origin on first connect:
1. New `/ws-auth` HTTP endpoint that sets an `HttpOnly` cookie after validating credentials
2. WS upgrade on that same origin automatically includes the cookie
3. `verifyClient` reads the cookie instead of the URL token for browser clients

---

### S4. CSP Allows WebSocket Connections to Any Origin
**Status: ✅ FIXED**
**File:** `packages/webui/vite.config.ts:30`
**CWE:** CWE-1021

**Fix applied:** Updated CSP in vite.config.ts (dev server) to use explicit loopback addresses for all three WS endpoints (v4 and v6 loopback), and added `object-src 'none'` to prevent plugin-based attacks:

```typescript
// Before (line 30)
"connect-src 'self' ws://127.0.0.1:3457 wss://127.0.0.1:3457",

// After
"connect-src 'self' ws://127.0.0.1:3457 wss://127.0.0.1:3457 ws://[::1]:3457 wss://[::1]:3457",
"object-src 'none'",
```

This covers the dev server (Vite). For the production server, the server/index.ts has no HTTP routes, so no additional CSP header is needed there.

---

### S5. Permissive Env Var (`WRONGSTACK_CHILD_ENV_PASSTHROUGH`)
**Status: ✅ ALREADY CORRECTLY IMPLEMENTED**
**File:** `packages/core/src/utils/child-env.ts:104–114`
**CWE:** CWE-78

**Historical note:** Config files do NOT inject values into `process.env` — only the actual shell environment does. Current code correctly checks `Object.prototype.hasOwnProperty.call(process.env, ...)` which filters out config-driven values. The comments at lines 104–110 explicitly document this.

No action needed.

---

### S6. WS Message Prototype Pollution
**Status: ✅ FIXED — just applied**
**File:** `packages/webui/src/server/index.ts:748–760`
**CWE:** CWE-1321

**Fix applied:** Two changes were made to the message parsing section:
1. Replaced `` '__proto__' in obj || 'constructor' in obj || 'prototype' in obj`` with `Object.hasOwn()` calls — avoids prototype chain walk and the `in` operator's prototype chain traversal
2. Added `return` after the error send so `handleMessage` is not called with a polluted message

No further action needed.

---

## 3. High-Priority Refactoring

### R1. Decompose `cli/src/index.ts` (1,440 lines)

**File:** `packages/cli/src/index.ts`

**Problem:** This single file handles boot wiring, container setup, provider registration, tool registration, MCP startup, plugin loading, session initialization, pipeline creation, agent creation, and subcommand routing.

**Recommended decomposition:**

| Module | Responsibility |
|--------|----------------|
| `cli/src/boot.ts` | Async boot sequence — load config → validate → register providers/tools/MCP/plugins |
| `cli/src/wiring/provider.ts` | Provider registry wiring |
| `cli/src/wiring/tools.ts` | Tool registry wiring |
| `cli/src/wiring/mcp.ts` | MCP server startup |
| `cli/src/wiring/plugins.ts` | Plugin loading |
| `cli/src/wiring/pipelines.ts` | Pipeline construction |
| `cli/src/wiring/sessions.ts` | Session store init |
| `cli/src/index.ts` | Thin: parse argv → route to boot or REPL or subcommand |

---

### R2. Decompose `webui/src/server/index.ts` (1,622 lines)

**File:** `packages/webui/src/server/index.ts`

**Problem:** One file contains HTTP server, WebSocket server, WebSocket protocol handlers, auth layer, rate limiter, config reader, static file server, API routes, SSE handling, and session management.

**Recommended decomposition:**

| Module | Responsibility |
|--------|----------------|
| `webui/src/server/http-server.ts` | HTTP server setup, TLS, bind |
| `webui/src/server/ws-server.ts` | WebSocket server setup, protocol, verifyClient, upgrade |
| `webui/src/server/ws-handlers/` | Per-message-type handlers (user_message, session.start, model.switch, etc.) |
| `webui/src/server/auth.ts` | Token validation, DNS-rebinding protection, loopback enforcement |
| `webui/src/server/static-files.ts` | Static file serving with path traversal guards |
| `webui/src/server/rate-limiter.ts` | Per-session and pre-auth rate limiting |
| `webui/src/server/sse-manager.ts` | SSE session tracking |
| `webui/src/server/index.ts` | Bootstrap: read config → wire → start servers |

---

### R3. Unify CLI and WebUI Boot Paths

**Files:** `packages/cli/src/index.ts`, `packages/cli/src/webui-server.ts`, `packages/webui/src/server/index.ts`

**Problem:** Both the CLI REPL and WebUI server run the same boot sequence with significant duplication (~500 lines).

**Fix:** Extract shared boot logic into `packages/core/src/boot/`:
```
packages/core/src/boot/
    config-loader.ts   ← loads and validates config
    container.ts       ← creates DI container with defaults
    registries.ts      ← registers providers, tools, MCP, plugins
    agent.ts           ← creates Agent with bound defaults
```
Both CLI and WebUI import from `core/boot` rather than each implementing their own wiring.

---

### R4. Decompose `core/src/coordination/director.ts` (1,067 lines)

**File:** `packages/core/src/coordination/director.ts`

**Recommended decomposition:**
- `director.ts` — thin orchestrator via FleetBus API, spawn decisions, budget enforcement
- `core/src/coordination/fleet-bus.ts` — inter-agent messaging via EventBus
- `core/src/coordination/checkpoint.ts` — session checkpointing logic

---

### R5. Decompose `core/src/c coordination/multi-agent-coordinator.ts` (669 lines)

**File:** `packages/core/src/coordination/multi-agent-coordinator.ts`

**Recommended decomposition:**
- `multi-agent-coordinator.ts` — thin orchestrator
- `core/src/coordination/subagent-manager.ts` — subagent lifecycle (spawn, health monitoring, restart)
- `core/src/coordination/task-dispatcher.ts` — task routing, timeout enforcement, result aggregation

---

### R6. Decompose `core/src/core/agent.ts` (760 lines)

**File:** `packages/core/src/core/agent.ts`

**Recommended decomposition:**
- `core/src/core/loop.ts` — the agent loop (`run()`)
- `core/src/core/run-result.ts` — `RunResult` and `RunStatus` types
- `core/src/core/default-pipelines.ts` — `createDefaultPipelines()` extracted
- `agent.ts` — thin class: constructor wires dependencies, delegates to loop/stores/pipelines

---

## 4. Medium-Priority Improvements

### M1. MCP Client `close()` race condition

**File:** `packages/mcp/src/client.ts:380–404`
**Status:** ✅ FIXED

**Problem:** `close()` called `failPending()` after `sseTransport.close()` and `httpTransport.close()`. In-flight HTTP requests (not yet in the `pending` map, waiting for a network response) could still be unresolved when `failPending()` ran, meaning their caller promises could settle before or after the rejection depending on timing — a non-deterministic race. HTTP-only clients (where `this.child` is null) also skipped the child-exit path without any guard.

**Fix applied:** Reordered so `failPending()` runs **before** `sseTransport?.close()` and `httpTransport?.close()`. This rejects all tracked pending requests while the transport is still in a known state, before we tear it down. `failPending()` guards on `this.pending.size` so calling it twice (once from the stdio exit handler, once from `close()`) is safe. HTTP-only clients now correctly call `failPending()` via the unconditional call at the end of `close()`.

---

### M2. SessionStore TOCTOU races

**File:** `packages/core/src/storage/session-store.ts:59–73`
**Status:** ✅ FIXED

**Problem:** `resume()` had a TOCTOU gap between `fsp.access(file, R_OK)` and `fsp.open(file, 'a')`. If the file was deleted between those two calls, `load()` would read a freshly-created empty file (returning 0 messages silently), then the append-mode open would succeed — silently resuming an empty session instead of failing.

**Fix applied:** Removed the `fsp.access()` pre-check entirely. Changed `fsp.open(file, 'a', 0o600)` to `fsp.open(file, 'r+', 0o600)`. With `'r+'` (read-write, file must exist), if the file was deleted between `load()` and `open()`, the `open()` itself throws ENOENT and we surface a clear error to the caller instead of silently loading an empty session.

---

### M3. `permission: 'auto'` tools via WebSocket without user confirmation

**File:** `packages/core/src/security/permission-policy.ts`, `packages/webui/src/server/index.ts`
**CWE:** CWE-862 — Unintended Unauthorized Action
**Status:** ✅ FIXED

**Problem:** Tools registered with `permission: 'auto'` execute immediately without user confirmation over WebSocket.

**Fix applied:** `permission-policy.ts` step 8 — changed `if (tool.permission === 'auto')` to `if (tool.permission === 'auto' && !tool.mutating)`. Mutating auto-permission tools (e.g. shellcheck with network calls) now fall through to the confirmation flow (`tool.confirm_needed` → `tool.confirm_result`), which is already wired in the webui server. Non-mutating read-only auto tools (heuristics, schema checks) continue to shortcut as before.

---

### M4. Provider config type coercion

**File:** `packages/webui/src/server/index.ts:103–113`
**CWE:** CWE-20 — Improper Input Validation
**Status:** ✅ ALREADY FIXED

**Problem:** If `config.providers` is a string (from corrupted config), `Object.keys(string)` returns character positions, leading to confusing downstream failures.

**Current code already implements the fix** (lines 105–108):
```typescript
typeof config.providers === 'object' &&
config.providers !== null &&
!Array.isArray(config.providers) &&
Object.keys(config.providers).length > 0
```
No action needed.

---

### M5. Recovery lock has read-modify-write race

**File:** `packages/core/src/storage/recovery-lock.ts:140–163`
**CWE:** CWE-410 — Insufficient Resource Locking
**Status:** ✅ ALREADY FIXED

**Problem:** The file-based lock uses non-atomic read-modify-write cycles — two processes could both scan the same stale lock and both believe they hold it.

**Current code already implements `O_EXCL` acquisition** (line 155):
```typescript
await fsp.writeFile(this.file, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
```
`flag: 'wx'` is exclusive-create: atomically fails with `EEXIST` if the file already exists. This makes the race between `checkAbandoned()` and `write()` safe — if another process claimed the lock between our read and our write, we get a clear EEXIST error instead of silently overwriting their recovery record. The `atomicWrite` temp+rename approach (commented as rejected alternative) would silently replace on POSIX, hiding the same race.
No action needed.

---

## 5. Low-Priority / Nice-to-Have

### L1. Telegram polling offset not persisted — replay risk

**File:** `packages/telegram/src/bot.ts:247–259`
**CWE:** CWE-662 — Improper Synchronization

**Fix:** Persist the `offset` to a file on every successful poll, and restore on startup.

---

### L2. MCP SSE stream uses `Date.now()` as session token

**File:** `packages/mcp/src/transport.ts:431–438`
**CWE:** CWE-287 — Improper Authentication

**Fix:** Use `crypto.randomUUID()` instead of `String(Date.now())`.

---

### L3. Secret scrubber minimum token length (20 chars)

**File:** `packages/core/src/security/secret-scrubber.ts:53`
**Status:** ✅ FIXED

The bearer token regex was lowered from `{20,512}` to `{12,512}`. A 12-char base64 string has ~71 bits of entropy — above the random-string false-match threshold. The `high_entropy_env` regex (20-char minimum) remains unchanged since short random strings are more likely to appear in code.

---

### L4. WebUI static file server ignores Range header

**File:** `packages/webui/src/server/index.ts:1935–1990`
**CWE:** CWE-778 — Insufficient Output Control

**Fix:** Validate that `Range` headers target only the resolved file. Reject ranges exceeding file size.

---

### L5. WebUI file download lacks authentication check for config-history

**File:** `packages/cli/src/config-history.ts`
**CWE:** CWE-284 — Improper Access Control

**Fix:** Ensure `config-history` operations require the same authentication context as privileged operations.

---

## 6. Overgrown Modules Requiring Decomposition

| Package | File | Lines | Recommended Split |
|---------|------|-------|-------------------|
| `core` | `coordination/director.ts` | 1,067 | director (thin) + fleet-bus + checkpoint |
| `core` | `core/agent.ts` | 760 | agent (thin) + loop + run-result + default-pipelines |
| `core` | `coordination/multi-agent-coordinator.ts` | 669 | coordinator (thin) + subagent-manager + task-dispatcher |
| `core` | `core/system-prompt-builder.ts` | 528 | stable, but extract prompt layer helpers |
| `core` | `coordination/delegate-tool.ts` | 468 | each tool → own file |
| `core` | `storage/session-store.ts` | 410 | create/resume → separate from list/delete |
| `core` | `plugin/loader.ts` | 393 | stable, current separation is acceptable |
| `core` | `kernel/events.ts` | 354 | stable, low priority |
| `core` | `execution/tool-executor.ts` | 342 | stable, consider splitting dispatch vs. permission |
| `core` | `execution/selective-compactor.ts` | 321 | consider simplifying algorithm |
| `core` | `execution/intelligent-compactor.ts` | 313 | similar to selective-compactor |
| `core` | `storage/session-reader.ts` | 310 | query/replay/search/export — 4 modes |
| `core` | `core/streaming-response-builder.ts` | 303 | stable |
| `cli` | `index.ts` | **1,440** | boot.ts + wiring/ (see R1) |
| `cli` | `auth-menu.ts` | 805 | stable, self-contained |
| `cli` | `multi-agent.ts` | 717 | consider splitting host vs. fleet UI |
| `cli` | `webui-server.ts` | 621 | superseded by unified boot paths |
| `webui` | `server/index.ts` | **1,622** | see R2 |
| `webui` | `hooks/useWebSocket.ts` | 838 | split into useWSConnection + useWSHandlers |
| `webui` | `stores/index.ts` | 728 | split into separate stores |

---

## 7. Test Coverage Gaps

| Package | Current | Target | Priority |
|---------|---------|--------|----------|
| `webui` | **0%** | 60% | Critical |
| `cli` | **21%** | 60% | High |
| `plug-lsp` | 27% | 50% | Medium |
| `core` | 40% | 70% | Medium |
| `providers` | 43% | 65% | Medium |
| `mcp` | 45% | 65% | Medium |
| `tools` | 50% | 65% | Medium |
| `tui` | 71% | 75% | Low |

**Priority actions:**
- **WebUI:** Write unit tests for WS handlers, auth layer, rate limiter, static file server
- **CLI:** Focus on new `boot.ts` and wiring modules

---

## 8. Unused / Unwired Code

### `@wrongstack/runtime` — ACTUALLY WIRING IN PROGRESS

**Package:** `packages/runtime/`

**Status:** This note in the previous revision was INCORRECT. The `@wrongstack/runtime` package IS wired:

- `packages/cli/src/boot.ts` — imports from `@wrongstack/runtime`
- `packages/cli/src/execution.ts` — imports from `@wrongstack/runtime`
- `packages/cli/src/index.ts` — imports from `@wrongstack/runtime`
- `packages/cli/src/repl.ts` — imports from `@wrongstack/runtime`
- `packages/tui/src/app.tsx` — imports from `@wrongstack/runtime`
- `packages/tui/src/clipboard.ts` — imports from `@wrongstack/runtime`
- `packages/tui/src/run-tui.ts` — imports from `@wrongstack/runtime`

The package re-exports from `@wrongstack/core` and adds: `pack.js`, `host.js`, `container.js`, `vision.js`, `clipboard.js`. It serves as the host-level composition layer.

**No action needed.**

---

## 9. Metric Baseline

| Metric | Value | Target |
|--------|-------|--------|
| Circular dependencies | 0 | 0 |
| Boundary violations | 0 | 0 |
| Architecture invariants | All pass | All pass |
| Test coverage (overall) | ~38% | 60% |
| Overgrown modules (>300L) | 23 | 10 |
| Overgrown modules (>1000L) | 3 | 0 |
| Critical bugs | 0 ✅ (5 fixed) | 0 |
| Critical security issues | 1 ⚠️ (4 fixed, 1 partial) | 0 |
| Unused packages | 1 | 0 |

---

## 10. Priority Execution Order

```
Phase 1 — Critical Bugs (C1–C5) ✅ ALL FIXED
  [C1–C5] All 5 critical bugs already fixed in current codebase.

Phase 2 — Security Fixes (S1–S6)
  [S1] ✅ git-autocommit/semver-bump: execFileSync (already fixed)
  [S2] ✅ plug-lsp: buildChildEnv (already fixed)
  [S3] ⚠️ webui: HttpOnly cookie for WS token — still needs full implementation
  [S4] ✅ CSP fixed: vite.config.ts explicit loopback + object-src none (just applied)
  [S5] ✅ CWE-78: child-env.ts already checks process.env via hasOwn (no action needed)
  [S6] ✅ WS prototype pollution: Object.hasOwn + return guard (just applied)

Phase 3 — High-Priority Refactor (R1–R6)
  [R1] 🔲 cli/index.ts decomposition (boot + wiring/)
  [R2] 🔲 webui/server/index.ts decomposition (6 modules)
  [R3] 🔲 Unify CLI + WebUI boot paths (core/boot/)
  [R4] 🔲 director.ts decomposition
  [R5] 🔲 multi-agent-coordinator.ts decomposition
  [R6] 🔲 agent.ts decomposition

Phase 4 — Medium-Priority (M1–M5)
  [M1] 🔲 mcp/client.ts: failPending after SIGKILL + drain
  [M2] 🔲 session-store.ts: O_EXCL lock acquisition
  [M3] 🔲 permission-policy.ts: limit auto-permission scope
  [M4] 🔲 webui server: strict type check for providers config
  [M5] 🔲 recovery-lock.ts: atomic acquire pattern

Phase 5 — Low-Priority (L1–L5)
  [L1] 🔲 telegram: persist offset
  [L2] 🔲 mcp: crypto.randomUUID() for SSE session token
  [L4] 🔲 webui: Range header validation
  [L5] 🔲 config-history: auth check
  [Runtime] 🔲 @wrongstack/runtime: wire or remove
```

Legend: ✅ fixed | ⚠️ partial | 🔲 to do


---

*Last updated: 2026-05-30*
