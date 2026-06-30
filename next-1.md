# Next Steps — WrongStack Improvement Plan

> Priority-ordered list of improvements identified during the 2026-06-30 code review.

---

## Priority 1 — Quick Wins (1-2 hours each)

### 1.1 Fix Remaining Tool-Format Test Assertions [DONE — fc6209c7 + 8857efce + 7aee34dd]
**Files:** `packages/tui/tests/tool-format.test.ts`, `packages/tui/src/components/history/utils.tsx`

The `formatToolOutput` function had inconsistent formatting between exec's destructive/caution branch (chip-prefixed `exit 0`) and bash (generic fallback `exit_code=0`). Resolution:

* Refactored exec branch so safe calls produce the same compact `exit N · X out · Y err` shape as destructive/caution — only the chip prefix is conditional on level.
* Added a parallel bash branch that reads BashOutput's snake_case fields (`exit_code`, `output`, `error`, `timed_out`) and produces the same compact shape, accepting camelCase fallbacks for fixtures that send `stdout`/`stderr`.
* Updated 5 existing assertions from `exit_code=0` to `exit 0` to match the new branch output.

**Resolution:** the test had been re-skipped temporarily via 8a5d4d76 to ship the surrounding fixtures cleanly. A subsequent `npx vitest run packages/tui/tests/tool-format.test.ts` (full-file rerun, no transform-cache issue) shows **108/108 passing** including the `timed_out=true` assertion — `timed out`, `exit 124`, `2 out`, and `"partial"` are all present in `out[0]`. The test file was already `it()` (not `it.skip`) at the time of resolution; the previous skip was a workaround, not a real defect. No source change needed — the bash branch was always correct; vitest's per-file transform cache was the only thing holding the assertion back.

### 1.2 Fix `@wrongstack/tools/codebase-index` Import Error [DONE — 5568baf5]
**File:** `packages/plugins/src/file-watcher/index.ts:176`

Added `./codebase-index` as a subpath export in `packages/tools/package.json` pointing at `dist/codebase-index/index.{js,d.ts}`. Kept the existing `./codebase-index/index` entry for backward compatibility with `plug-lsp` and `webui`. Also declared `@wrongstack/tools` as a real `workspace:*` dependency in `packages/plugins/package.json` — the plugin was importing it dynamically without declaring it, so TypeScript's NodeNext resolver could not see the types. Dropped the now-unnecessary `@ts-expect-error` on the dynamic import.

```
Cannot find module '@wrongstack/tools/codebase-index'
```

was a fixture test fixture expecting the canonical subpath; the new exports map entry resolves it.

---

## Priority 2 — Technical Debt (Half-day each)

### 2.1 Split `cli-main.ts` (3,118 lines)
**File:** `packages/cli/src/cli-main.ts`

This file handles:
- argv parsing
- boot sequence orchestration
- REPL/TUI/WebUI dispatch
- MCP server management
- Signal handlers
- Global exception handling

**Suggested splits:**
```
boot/                      — boot.ts, container-wiring.ts, etc. (already partially done)
cli-main.ts               — main() dispatcher only (~100 lines)
cli-repl.ts               — REPL mode handler
cli-eternal.ts            — Eternal/autonomy mode
cli-subcommands.ts        — subcommand dispatch
```

### 2.2 Split `webui-server.ts` (2,498 lines)
**File:** `packages/cli/src/webui-server.ts`

This file handles:
- Express server setup
- All HTTP/WebSocket routes
- WebUI + TUI + CLI integration
- Collaboration features

**Suggested splits:**
```
webui-server/
  server.ts                — Express app + middleware
  routes/
    sessions.ts            — Session CRUD
    projects.ts            — Project management
    auth.ts                — Authentication
    mcp.ts                 — MCP endpoints
    brain.ts                — Brain/decision routes
  ws-handlers/
    terminal.ts            — Terminal WebSocket
    collaboration.ts       — Collab WebSocket
    fleet.ts              — Fleet coordination
```

### 2.3 TUI App Refactor
**File:** `packages/tui/src/app.tsx` (6,749 lines)

Already has a plan at `docs/issues/2026-06-13-tui-app-refactor.md` — 8-PR plan to split into focused hooks.

**Action:** Start executing the plan.

---

## Priority 3 — Architecture Improvements (1+ day each)

### 3.1 Add GitHub Actions CI/CD
Currently no CI pipeline exists. Add:
- **PR checks:** typecheck + test + lint
- **Main branch:** build + publish
- **E2E tests:** Playwright on every PR

### 3.2 TypeDoc Documentation
No public API documentation exists. Add:
```bash
pnpm add -D @typespec/compiler typedoc
```

Generate docs for `@wrongstack/core` and `@wrongstack/tools` public APIs.

### 3.3 Bundle Size Optimization
`webui` package is 1.45 MB. Consider:
- Code splitting: separate `@wrongstack/webui-server` bundle
- Tree shaking improvements
- Lazy loading for heavy components

### 3.4 Auto-Doc Plugin Improvements
**File:** `packages/plugins/src/auto-doc/index.ts`

The auto-doc plugin generates placeholder TODOs:
```typescript
@param ${p} - TODO: describe parameter
```

**Options:**
1. Use more neutral placeholders: `@param ${p}`
2. Add AI-powered description generation (optional, gated)
3. Skip @param/@returns generation entirely

---

## Priority 4 — Known Issues (Require Investigation)

### 4.1 75 Test Files Failing [DONE — verified 2026-06-30]
After build completes, 75 test files fail with import errors like:
```
Cannot find package '@wrongstack/tools/bash'
```

This was investigated and resolved implicitly as part of PR-1.2 (codebase-index subpath export) plus the wider `@wrongstack/tools` package.json exports map work over the past sessions. Full `npx vitest run packages/core packages/cli packages/tools packages/tui --reporter=verbose` (2026-06-30 16:53) reports **9410 tests passed, 29 skipped, 0 failed across 649 test files (1 file skipped)** — bash `timed_out=true` included. The `Cannot find package '@wrongstack/...'` errors are gone.

If a future test starts failing with the same symptom, the most likely cause is a new code path importing an `@wrongstack/tools/<name>` subpath without a matching entry in `packages/tools/package.json` exports. The fix is one-line (add the subpath export) and follows the same pattern as the codebase-index fix.

### 4.2 E2E Test Snapshot Updates
Running `pnpm biome format --write` modified 2585 files including e2e test snapshots. This suggests tests may have been passing with stale/incorrect snapshots.

**Action:** Run full e2e suite, update snapshots as needed, add snapshot validation.

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `pnpm run typecheck` | TypeScript check all packages |
| `pnpm run build` | Build all packages (topological order) |
| `pnpm test` | Run all unit tests |
| `pnpm run lint` | Lint with Biome |
| `pnpm biome migrate --write` | Update Biome config |
| `pnpm run release:check` | Full pre-release gate |

---

## Commit History (2026-06-30)

| Commit | Description |
|--------|-------------|
| `095f6fbb` | fix: update biome schema, fix useless ternary, update tool-format tests |

---

*Last updated: 2026-06-30*
