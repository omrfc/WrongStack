# WrongStack — Fix & Refactor Action Plan

**Generated:** 2026-05-21  
**Status:** In Progress  
**Based on:** Deep analysis + prior bug-hunt/security-audit/architecture reports

---

## Quick Reference

| Priority | Item | Severity | Effort |
|:--------:|------|:--------:|:------:|
| P0 | `exec` tool — npm/pnpm/npx injection | CRITICAL | LOW |
| P1 | WebUI WebSocket auth | HIGH | MEDIUM |
| P2 | `cli/src/index.ts` decomposition | HIGH | MODERATE |
| P3 | WebUI server decomposition | HIGH | MODERATE |
| P4 | WebUI test coverage | HIGH | HIGH |
| P5 | ExtensionRegistry snapshot fix | MEDIUM | LOW |
| P6 | Runtime pack wiring | MEDIUM | MODERATE |
| P7 | MemoryStore error propagation | MEDIUM | LOW |
| P8 | `delegate-tool` fs race | LOW | LOW |

---

## P0 — `exec` Tool Injection Fix

**File:** `packages/tools/src/exec.ts`  
**Severity:** CRITICAL (Security)  
**Effort:** LOW

### Problem

The `exec` tool allowlist only checks command names, not sub-commands. This allows arbitrary code execution through package manager scripts:

```typescript
exec({ command: 'npm', args: ['run', 'malicious-script'] })   // ✅ ALLOWED
exec({ command: 'pnpm', args: ['dlx', 'malicious-tool'] })  // ✅ ALLOWED
exec({ command: 'npx', args: ['malicious-package'] })       // ✅ ALLOWED
exec({ command: 'npm', args: ['exec', '--', 'evil'] })       // ✅ ALLOWED
```

`BLOCKED_ARG_PATTERNS` blocks some flags but not `run`, `dlx`, `exec`, `create` sub-commands.

### Fix

Add sub-command blocking patterns to `BLOCKED_ARG_PATTERNS`:

```typescript
const BLOCKED_ARG_PATTERNS: Record<string, RegExp[]> = {
  // ... existing patterns ...

  // NEW: block script execution through package managers
  npm: [/^run$/, /^exec$/, /^create$/, /^init$/, /^pack$/, /^publish$/],
  pnpm: [/^run$/, /^dlx$/, /^exec$/, /^create$/, /^init$/, /^pack$/, /^publish$/],
  npx: [/^[^\s]+$/],  // block any package name — npx should only be used for --version
  bun: [/^run$/, /^bunx$/, /^exec$/, /^create$/],
  // ... rest ...
};
```

### Notes

- `npm --version`, `pnpm --version`, `npx --version` still work (flag-only args)
- This breaks `npm run build` but that was never the intent of the "restricted exec" tool
- Users who need script execution should use the `bash` tool (which requires `confirm` permission)

---

## P1 — WebUI WebSocket Authentication

**File:** `packages/webui/src/server/index.ts`  
**Severity:** ~~HIGH~~ MEDIUM (already partially implemented — see below)  
**Effort:** MEDIUM

### Problem

WebSocket server accepts connections without any authentication. Any LAN attacker can connect to the WrongStack WebUI when bound to `0.0.0.0`.

### Status: ✅ ALREADY IMPLEMENTED

Token-based auth exists in current code:

- `wsToken = randomBytes(16).toString('hex')` generated at startup (line 385)
- `verifyClient` validates `?token=...` query param against `wsToken` (lines 394-426)
- Loopback origins skip token; non-loopback requires token when `wsHost !== '127.0.0.1'`
- Token printed to console and included in `sessionStartPayload().wsToken`

### Remaining Sub-Task: Add WebUI Server Tests

Zero tests for 4,589 lines. Priority test areas:
- WebSocket connection auth (valid/invalid/missing token)
- Config write race between `model.switch` and `key.add`
- Run lifecycle (start/stop/restart/state transitions)

---

## P2 — `cli/src/index.ts` Decomposition

**File:** `packages/cli/src/index.ts` (1,440 lines)  
**Severity:** HIGH (Maintainability)  
**Effort:** MODERATE

### Problem

Single 1,440-line file handles all CLI REPL initialization:
- Boot config parsing
- Provider wiring  
- Tool registry setup
- Session initialization
- MCP registry wiring
- Permission policy setup
- Metrics wiring
- Slash command registration
- Auto-compaction middleware setup
- Metrics server startup

### Target Structure

```
packages/cli/src/
├── index.ts                    # Entry point (console arg routing only, ~100 lines)
├── wiring/
│   ├── pipeline.ts            # createAgent + setupPipelines + setupCompaction
│   ├── provider.ts            # setupProvider + makeProviderFromConfig
│   ├── session.ts             # setupSession + session store
│   ├── tools.ts               # Tool registry setup + builtin tools
│   ├── slash-commands.ts      # Slash command registration
│   ├── plugins.ts             # Plugin + MCP wiring
│   └── metrics.ts             # Metrics wiring + server
├── boot.ts                    # Orchestrates wiring steps
├── repl.ts                    # REPL loop (already exists, keep)
└── utils.ts                   # patchConfig + helpers (already exists)
```

### Order of Extraction

1. **Extract `wiring/tools.ts`** — Tool registry + builtin tools
2. **Extract `wiring/provider.ts`** — Provider setup
3. **Extract `wiring/slash-commands.ts`** — Slash commands
4. **Extract `wiring/pipeline.ts`** — Agent + pipelines + compaction
5. **Extract `wiring/session.ts`** — Session setup
6. **Extract `wiring/plugins.ts`** — Plugin/MCP wiring
7. **Extract `wiring/metrics.ts`** — Metrics wiring
8. **Simplify `index.ts`** to just route to subcommands and call `boot()`

### Constraints

- Keep backward compatibility for any external consumers
- Keep `repl.ts` intact (already separate)
- Don't mix with WebUI changes
- Run tests after each extraction

---

## P3 — WebUI Server Decomposition

**File:** `packages/webui/src/server/index.ts` (1,622 lines)  
**Severity:** HIGH (Maintainability)  
**Effort:** MODERATE

### Problem

WebUI server grew from small backend to 1,622 lines. Duplicates ~500 lines from CLI boot.

### Target Structure

```
packages/webui/src/server/
├── index.ts                    # HTTP server setup + WebSocket upgrade (entry)
├── agent-setup.ts              # Agent construction + tools/providers wiring
├── ws-server.ts                # WebSocket message handling
├── model-handlers.ts           # Model switch, provider config handlers
├── run-control.ts              # Start/stop/restart run logic
├── auth.ts                     # WebSocket auth token generation + validation
└── boot.ts                     # Orchestrates all the above
```

### Order of Extraction

1. **Extract `auth.ts`** — Auth token generation + validation (small, isolated)
2. **Extract `model-handlers.ts`** — `model.switch`, `key.add`, `key.del` handlers
3. **Extract `run-control.ts`** — `run.start`, `run.stop`, `run.restart` handlers
4. **Extract `ws-server.ts`** — WebSocket message routing
5. **Extract `agent-setup.ts`** — Agent + pipeline creation
6. **Simplify `index.ts`** to wiring + event routing

### Notes

- Pair this with P1 (auth) — auth should be its own small module anyway
- Run existing tests after each extraction
- **Add tests for each new module** — this is the chance to build test coverage from zero

---

## P4 — WebUI Test Coverage

**File:** `packages/webui/src/server/**/*.ts`, `packages/webui/tests/**/*.ts`  
**Severity:** HIGH (Quality)  
**Effort:** HIGH

### Problem

WebUI has 0% test coverage for 4,589 lines.

### Target

Minimum viable coverage: 40% for server/, focus areas:

```
packages/webui/tests/
├── server/
│   ├── boot.test.ts           # Server startup/shutdown
│   ├── auth.test.ts           # WebSocket auth token
│   ├── ws-server.test.ts     # Message routing
│   ├── model-handlers.test.ts # Config mutations
│   └── session-payload.test.ts # Already exists, expand
└── lib/
    ├── utils.test.ts          # Already exists
    ├── notify.test.ts         # Already exists
    └── tool-summary.test.ts   # Already exists
```

### Priority Test Cases

1. **Boot:** Server starts, binds port, WebSocket upgrade works
2. **Auth:** Valid token connects, invalid/missing token rejected
3. **Model switch:** Updates config, propagates to agent
4. **Run lifecycle:** start → running → stop → idle state transitions
5. **Error handling:** Invalid messages, malformed JSON

---

## P5 — ExtensionRegistry Snapshot Fix

**File:** `packages/core/src/extension/registry.ts`  
**Severity:** MEDIUM (Bug)  
**Effort:** LOW

### Problem

Hook runners use snapshot copying (`const snapshot = [...this.extensions]`), but `buildSystemPromptContributions` iterates directly on `this.promptContributors`:

```typescript
// Line 58 — NO snapshot copy
for (const c of this.promptContributors) {
  try {
    const contributed = await c(ctx);
```

If a contributor calls `registerSystemPromptContributor` during iteration, mid-iteration mutation occurs.

### Fix

```typescript
// In buildSystemPromptContributions:
async buildSystemPromptContributions(ctx: Parameters<SystemPromptContributor>[0]): Promise<TextBlock[]> {
  const blocks: TextBlock[] = [];
  const snapshot = [...this.promptContributors];  // ← add snapshot
  for (const c of snapshot) {  // ← iterate snapshot
    // ...
  }
  return blocks;
}
```

---

## P6 — `@wrongstack/runtime` Pack Wiring

**Files:** `packages/runtime/src/host.ts`, `packages/runtime/src/pack.ts`  
**Severity:** MEDIUM (Architecture)  
**Effort:** MODERATE

### Problem

`RuntimeHost`, `WrongStackPack`, `applyWrongStackPack` abstractions exist but are never used. CLI wires everything manually.

### Decision Required

**Option A: Complete the wiring**
- Import `WrongStackPack` into `cli/src/boot.ts`
- Extract tool/provider/slash-command registration into packs
- Reduces ~500 lines of duplicated boot logic between CLI and WebUI

**Option B: Remove unused code**
- If the pack system was exploratory and won't be used, remove it
- Clean up `packages/runtime/` to only contain what's actually used

### Implementation (Option A)

```typescript
// In cli/src/boot.ts:
// Instead of manual registry calls:
//   tools.register(builtinToolsPack)
//   providers.register(...)
//   slashCommands.register(...)

// Use:
import { applyWrongStackPacks } from '@wrongstack/runtime';
const packs = [builtinToolsPack, coreToolsPack, /* ... */];
applyWrongStackPacks({ tools, providers, slashCommands }, packs);
```

### Verification

```bash
# Should show only runtime/container.ts usage:
grep -r "createDefaultContainer" packages/ --include="*.ts"
# CLI and WebUI already use this — good
# But WrongStackPack is never imported:
grep -r "WrongStackPack" packages/ --include="*.ts"
# (should be zero)
```

---

## P7 — MemoryStore Error Propagation

**File:** `packages/core/src/storage/memory-store.ts`  
**Severity:** MEDIUM (Bug)  
**Effort:** LOW

### Problem

Write chain swallows errors silently:

```typescript
const next = prior.catch(() => undefined).then(work);
//             ^^^^^^^ error swallowed, chain continues
```

Failed `remember()` returns `ok: true` to caller.

### Fix

```typescript
// Option A: Track error state, return it on next read
private readonly writeChain = new Map<MemoryScope, Promise<{ err?: Error }>>();

// Option B: Propagate error on next call
async read(scope: MemoryScope): Promise<string> {
  const pending = this.writeChain.get(scope);
  if (pending) {
    const result = await pending.catch(() => ({ err: undefined }));
    if (result.err) {
      this.log?.error('Previous memory write failed', result.err);
    }
  }
  // ... rest of read ...
}
```

### Minimal Fix (Recommended)

Add error tracking with best-effort notification:

```typescript
private readonly writeErrors = new Map<MemoryScope, Error>();

private async runSerialized<T>(scope: MemoryScope, work: () => Promise<T>): Promise<T> {
  const prior = this.writeChain.get(scope) ?? Promise.resolve();
  // Log prior error but don't block
  prior.catch((err) => {
    this.writeErrors.set(scope, err as Error);
  });
  const next = prior.then(work);
  this.writeChain.set(scope, next as Promise<unknown>);
  // ...
}

async readAll(): Promise<string> {
  const parts: string[] = [];
  for (const scope of ['project-agents', 'project-memory', 'user-memory'] as MemoryScope[]) {
    // Surface write errors to caller
    const writeErr = this.writeErrors.get(scope);
    if (writeErr) {
      parts.push(`⚠️ Memory write error: ${writeErr.message}`);
    }
    // ... rest ...
  }
}
```

---

## P8 — `delegate-tool` Filesystem Race

**File:** `packages/core/src/coordination/delegate-tool.ts`  
**Severity:** LOW  
**Effort:** LOW

### Problem

```typescript
const runDirs = await fsp.readdir(opts.sessionsRoot);
for (const r of runDirs) {
  candidates.push(path.join(opts.sessionsRoot, r, `${subagentId}.jsonl`));
}
```

Race between subdirectory creation and `readdir`. Low risk in practice.

### Fix (Optional)

Use `fs.Dirent` with `isDirectory()` to filter, or add a small delay/retry:

```typescript
try {
  const entries = await fsp.readdir(opts.sessionsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      candidates.push(path.join(opts.sessionsRoot, entry.name, `${subagentId}.jsonl`));
    }
  }
} catch {
  return undefined;
}
```

---

## Prior Art (Already Fixed)

These items were in the 2026-05-16 reports but are **already fixed**:

| Item | Status |
|------|--------|
| `plugin/api.ts` `onEvent` uses `once` instead of `on` | ✅ Fixed |
| `unloadPlugins` creates fresh API instance | ✅ Fixed (pluginApiMap WeakMap) |
| `AgentBridge.stop()` doesn't reject pending | ✅ Fixed |
| `Director.spawnCount` incremented before spawn | ✅ Fixed |
| `ExtensionRegistry` mid-iteration mutation | ✅ Fixed (snapshot copy) |
| AgentBridge TOCTOU race | ✅ Fixed (double-check guard) |
| `DirectorState.flush()` returns early | ✅ Fixed |
| LSP `safeSpawn` env leak | ✅ Fixed (`buildChildEnv`) |
| SessionStore lazy init TOCTOU | ✅ Fixed |
| SessionStore `onEvent` → `once` | ✅ Fixed |

---

## Progress Checklist

- [x] P0: exec tool injection fix
- [x] P1: WebUI WebSocket auth (token already implemented; tests partial — see Recent additions)
- [~] P2: cli/src/index.ts decomposition — partial:
  - [x] `wiring/metrics.ts`, `wiring/plugins.ts` integrated
  - [ ] `wiring/slash-commands.ts` (113 lines, untracked) — stub, not imported yet; will need eternal-autonomy hooks (onEternalStart/onEternalStop/subscribeEternalIteration) added before integration
  - [ ] `wiring/tools.ts` (93 lines, untracked) — stub, not imported yet
  - `index.ts` still 1234 lines — further extraction needed
- [ ] P3: WebUI server decomposition
- [ ] P4: WebUI test coverage — partial (boot, provider-store, session-payload, ws-auth done; lifecycle/handlers still open)
- [x] P5: ExtensionRegistry snapshot fix
- [ ] P6: Runtime pack wiring (or removal)
- [x] P7: MemoryStore error propagation
- [x] P8: delegate-tool fs race

---

## Recent Additions (post-2026-05-21 — outside the original action plan)

### Eternal Autonomy / `/goal` system

**Status:** Shipped (commits `a818b84`, `1c27a92`)

A long-running self-driving loop (sense → decide → execute → reflect)
that consumes a persisted Goal and runs indefinitely until manually stopped.
The decide step is hybrid: pending todos → dirty git → LLM brainstorm
against the goal.

**Surfaces:**

| Command | Purpose |
|---|---|
| `/goal set\|clear\|status\|journal` | Persistent mission management (`.wrongstack/goal.json`) |
| `/autonomy eternal` | Start the loop (requires goal, force-enables YOLO) |
| `/autonomy stop` | Graceful halt with cumulative spend summary |
| `wstack --eternal "<mission>"` | One-shot launch from CLI |

**Features:**

- Per-iteration token + USD cost telemetry (`JournalEntry.tokens`, `costUsd`)
- Periodic compaction (cadence + threshold-based aggressive mode) to
  prevent context overflow on multi-day loops
- Crash recovery: `engineState='running'` on disk lets the next REPL
  startup offer interactive y/N resume
- REPL + TUI + WebUI parity — TUI renders live timeline entries via
  `engine.onIteration` subscription; WebUI broadcasts `eternal.iteration`
  WS messages for frontend observability
- Tests: 25 (goal-store + eternal-autonomy + slash commands)
- Total regression: 1765/1765 across 147 test files

**Files added:**

- `packages/core/src/storage/goal-store.ts`
- `packages/core/src/execution/eternal-autonomy.ts`
- `packages/cli/src/slash-commands/goal.ts`
- `packages/cli/tests/slash-{goal,autonomy}.test.ts`
- `packages/core/tests/{storage/goal-store,execution/eternal-autonomy}.test.ts`

**Files extended:**

- `packages/cli/src/{repl,execution,index,slash-commands/{autonomy,index}}.ts`
- `packages/cli/src/subcommands/handlers/version-help.ts`
- `packages/core/src/{defaults,execution,storage}/index.ts`
- `packages/tui/src/{app.tsx,run-tui.ts,components/status-bar.tsx}`
- `packages/cli/src/webui-server.ts` (broadcast only — separate from
  user's pre-existing saveProviders error-handling changes)

---

*Generated by WrongStack self-analysis on 2026-05-21*