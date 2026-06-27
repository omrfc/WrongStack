# Design: Structured Side Effect Recording (P2 #5)

## Problem

`recordFileChange()` tracks filesystem mutations (`edit`, `write`) for
session rewind and `/diag`. But the three highest-risk tool categories —
shell execution (`bash`), package installation (`install`), and network
requests (`fetch`) — leave no structured audit trail. Session replay can
show "what files changed" but not "which bash commands were run" or "what
URLs were fetched". `/rewind` can undo file edits but cannot undo a
`pnpm install` that added `node_modules/`.

## Goals

1. Record every bash/install/fetch execution as a structured session event.
2. Surface these in `/diag` (what did the agent do?).
3. Enable session replay to show a timeline of side effects.
4. Keep the recording lightweight (no heavy serialization on the hot path).

## Non-goals

- **Undo for non-filesystem side effects.** A `pnpm install` cannot be
  reversed by the session rewinder. This design records for audit only,
  not for automatic undo.
- **Network call logging.** `fetch` already returns its output to the model
  (and thus to the session log via `tool_result`). Side-effect recording
  here is about the *intent* (which URL was fetched), not the payload.

---

## Type design

### `SideEffect` — the recorded shape

```typescript
// New file: packages/core/src/types/side-effect.ts

export interface SideEffect {
  /** Session-unique tool call ID (from the tool_use block). */
  toolUseId: string;
  /** Tool name: 'bash' | 'install' | 'fetch' | ... */
  toolName: string;
  /** ISO timestamp. */
  ts: string;
  /** The input the tool received (command, url, packages). */
  input: Record<string, unknown>;
  /**
   * Optional outcome summary — NOT the full output (that's already in the
   * tool_result block). A short string like "exit 0", "installed 42 packages",
   * "HTTP 200 (12KB)", or "timed out".
   */
  outcome?: string | undefined;
  /**
   * Risk classification for filtering in /diag.
   * - 'fs.write'   — filesystem mutation (edit, write, patch)
   * - 'shell'      — arbitrary shell command (bash, exec)
   * - 'package'    — package installation (install)
   * - 'network'    — outbound network request (fetch)
   * - 'config'     — config mutation (settings)
   */
  risk: 'fs.write' | 'shell' | 'package' | 'network' | 'config';
}
```

### New session event type

```typescript
// Added to the SessionEvent union in packages/core/src/types/session.ts

| {
    type: 'side_effect';
    ts: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    outcome?: string | undefined;
    risk: 'fs.write' | 'shell' | 'package' | 'network' | 'config';
  }
```

This follows the existing event pattern (e.g., `tool_call_start`,
`file_snapshot`) — a single JSONL line per side effect.

---

## API surface

### `Context.recordSideEffect()`

```typescript
// packages/core/src/core/context.ts

/**
 * Record a structured side effect for the audit trail.
 * Called by tools that perform non-filesystem mutations (bash, install,
 * fetch) so /diag and session replay can show what the agent did beyond
 * file edits.
 *
 * Unlike recordFileChange(), this does NOT support undo — it is purely
 * for observability and audit.
 */
recordSideEffect(sideEffect: SideEffect): void {
  this.sideEffects.push(sideEffect);
  this.session.append({
    type: 'side_effect',
    ts: sideEffect.ts,
    toolUseId: sideEffect.toolUseId,
    toolName: sideEffect.toolName,
    input: sideEffect.input,
    outcome: sideEffect.outcome,
    risk: sideEffect.risk,
  }).catch(() => { /* best-effort */ });
}
```

Key decisions:
- **Fire-and-forget append.** The `session.append()` is not awaited — side
  effect recording must never block tool execution. If the session file is
  locked or slow, the event is silently dropped.
- **In-memory list.** `this.sideEffects` accumulates for the current run
  so `/diag` can read it without parsing the JSONL file. Cleared by
  `clearFileTracking()` (which should be renamed or a new `clearSideEffects()`
  added).

### `SessionWriter.recordSideEffect()`

The `SessionWriter` interface gains a no-op-default method so existing
mocks and test stubs don't need updating:

```typescript
// packages/core/src/types/session.ts — SessionWriter interface

/**
 * Record a structured side effect for audit. Implementations append a
 * 'side_effect' event to the session JSONL. Best-effort — errors are
 * swallowed by the caller.
 */
recordSideEffect(input: {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  outcome?: string | undefined;
  risk: 'fs.write' | 'shell' | 'package' | 'network' | 'config';
}): void;
```

---

## Wiring (per-tool)

### `bash.ts`

```typescript
// After the tool returns (both foreground and background paths), before
// the final yield:

ctx.recordSideEffect({
  toolUseId: use.id,          // from executeStream opts
  toolName: 'bash',
  ts: new Date().toISOString(),
  input: { command: redactCommand(input.command) },
  outcome: out.timed_out
    ? `timed out (exit ${out.exit_code})`
    : `exit ${out.exit_code}`,
  risk: 'shell',
});
```

**Input redaction**: the command is passed through `redactCommand()` (already
imported from `process-registry.ts`) so secrets in the command line don't
leak into the session JSONL.

### `install.ts`

```typescript
ctx.recordSideEffect({
  toolUseId: '<from executor>',
  toolName: 'install',
  ts: new Date().toISOString(),
  input: { packages: input.packages, cwd: input.cwd },
  outcome: `installed (${result.exitCode === 0 ? 'success' : 'failed'})`,
  risk: 'package',
});
```

### `fetch.ts`

```typescript
ctx.recordSideEffect({
  toolUseId: '<from executor>',
  toolName: 'fetch',
  ts: new Date().toISOString(),
  input: { url: input.url, format: input.format },
  outcome: `HTTP ${out.status} (${out.content_type})`,
  risk: 'network',
});
```

---

## `/diag` integration

`/diag` already reads from the session store. The side_effect events are
JSONL lines that the session reader already iterates. The `/diag` command
handler filters for `type: 'side_effect'` and renders a timeline:

```
## Side Effects (this session)

| Time | Tool | Risk | Detail |
|------|------|------|--------|
| 14:23 | bash | shell | `pnpm build` → exit 0 |
| 14:24 | install | package | `lodash, axios` → success |
| 14:25 | fetch | network | `https://api.example.com` → HTTP 200 |
| 14:26 | bash | shell | `rm -rf dist/` → exit 0 |
```

---

## Implementation phases

### Phase 1: Type + Context + SessionWriter (no tool changes)
- Add `SideEffect` type to `types/side-effect.ts`.
- Add `side_effect` to the `SessionEvent` union.
- Add `recordSideEffect()` to `Context` and `SessionWriter`.
- Add in-memory `sideEffects` list to `Context`.
- Implement `recordSideEffect` in `FileSessionWriter`.
- Tests: Context records, SessionWriter appends, JSONL line has the right shape.

### Phase 2: Wire bash.ts
- Call `ctx.recordSideEffect()` after bash execution (foreground + background).
- Use `redactCommand()` for the input.
- Tests: bash execution produces a side_effect event with the command and exit code.

### Phase 3: Wire install.ts + fetch.ts
- Same pattern as bash.
- Tests: each tool produces a side_effect event.

### Phase 4: /diag integration
- Filter session events for `type: 'side_effect'`.
- Render as a table.
- Tests: /diag output includes the side effect timeline.

---

## Risk assessment

| Factor | Risk | Mitigation |
|--------|------|------------|
| Session JSONL growth | Each bash call adds ~200 bytes | Acceptable — JSONL files are already multi-MB |
| `redactCommand` miss | A secret bypasses redaction | `redactCommand` is now test-covered (P2 #13) |
| Blocking on `session.append` | Tool execution stalls | Fire-and-forget (`.catch(() => {})`) |
| Memory growth from `sideEffects` list | Accumulates over a long run | Cleared on compaction (like `readFiles`) |
| Backward compatibility | Old session readers see unknown event type | JSONL readers already skip unknown `type` values |

---

## Alternatives considered

### A. Extend `recordFileChange` to cover non-file actions
Rejected — `recordFileChange` has a file-centric shape (`before`/`after`
content). Forcing bash commands into this shape (e.g., `before: null,
after: 'ran: pnpm build'`) conflates two concerns and breaks the undo
semantics.

### B. Use the existing `tool_call_end` event
Rejected — `tool_call_end` records timing and output size for every tool,
not just side-effect-producing ones. Mixing audit data into it would make
the event shape inconsistent (some have `risk`, some don't). A separate
`side_effect` event is cleaner.

### C. Store side effects in a separate file (not JSONL)
Rejected — the session JSONL is the single source of truth for what
happened in a run. Splitting audit data into a separate file creates a
synchronization problem (which file is authoritative?) and complicates
session replay.
