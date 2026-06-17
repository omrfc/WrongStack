# WebUI Testing Guidelines

## Coverage Ratchet Policy

Every new store or utility test file merged to `main` **must increase** the
coverage thresholds in `vitest.config.ts` by **+1** on each metric that the new
tests improve.

### Why?

Without a ratchet, thresholds stagnate and provide no signal. The policy
ensures coverage keeps pace with new code.

### How to apply it

1. Run `pnpm --filter webui test -- --coverage` locally.
2. Note the new aggregate values for `statements`, `branches`, `functions`, `lines`.
3. Update `vitest.config.ts` thresholds:
   ```ts
   thresholds: {
     statements: <new_stmts_value + 1>,
     branches:   <new_branches_value + 1>,
     functions:  <new_funcs_value + 1>,
     lines:      <new_lines_value + 1>,
   }
   ```
4. Update the "Current" comment block in `vitest.config.ts` with the new
   measured values.
5. Commit message: `test(webui): tighten coverage thresholds`

### Current measured coverage

| Metric    | Measured | Threshold |
|-----------|----------|-----------|
| statements | 19.21%  | 20        |
| branches  | 16.87%  | 17        |
| functions | 17.81%  | 18        |
| lines     | 19.83%  | 20        |

### What counts as a "store/utility test"

- Files matching `stores/*.test.ts`
- Files matching `**/slash-commands.test.ts`
- Files matching `**/code-detect.test.ts`
- Any new test file targeting a previously uncovered module

### Files excluded from 100% target

These require E2E or integration tests (not unit-testable in jsdom):

| File | LOC | Reason |
|------|-----|--------|
| `server/index.ts` | 3,652 | Node.js HTTP server, requires live runtime |
| `SkillsPanel.tsx` | 1,567 | React component, requires E2E |
| `AgentFlowCanvas.tsx` | 942 | React Flow canvas, requires E2E |
| `ChatInput.tsx` | 532 | React component, requires E2E |
| `ws-client.ts` | 724 | WebSocket wrapper, requires server |

## Running Tests

```bash
# Unit tests (vitest workspace — includes webui via workspace projects)
pnpm test

# Webui-only tests with coverage
pnpm --filter webui test -- --coverage

# E2E tests (requires WebUI server running)
pnpm test:e2e

# Full release gate
pnpm release:check
```

## Adding E2E Tests

E2E tests live in `e2e/*.spec.ts` and use Playwright.

```bash
# Run E2E tests
pnpm test:e2e

# Add new component tests in `e2e/<component>.spec.ts`
```
