import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Enforce coverage across the whole WebUI source, not just src/lib.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/dist/**',
        'src/env.d.ts',        // ambient type declarations only
        'src/main.tsx',        // ReactDOM bootstrap entry — exercised by E2E
        'src/lib/core-browser-shim.ts', // side-effect polyfill shim
        'src/server/entry.ts', // process/bootstrap entry — exercised at runtime
      ],
      // ── Coverage gate (ratchet) ────────────────────────────────────────────
      // Goal: 100% across the WebUI. Baseline measured 2026-06-17:
      //   stmts 15.55% · branches 13.05% · funcs 11.75% · lines 16.21%.
      // Updated 2026-06-17 (after ui-store tests):
      //   stmts 16.13% · branches 13.66% · funcs 13.49% · lines 16.76%.
      // The thresholds below are the current baseline (floored) so coverage
      // can NEVER regress — `pnpm test:coverage` fails if any metric drops.
      // Raise these four numbers as tests are added; set all to 100 to make
      // this a hard 100% gate (it will fail until the gap closes).
      // Biggest remaining gaps: server/index.ts (3.6k LOC), SkillsPanel/
      // ChatInput/AgentFlowCanvas (~1k LOC each, ~0%), ws-client.ts (0.8%).
      thresholds: {
        statements: 16,
        branches: 13,
        functions: 13,
        lines: 16,
        // Don't fail the gate on a single untouched file — the aggregate
        // ratchet above is what we enforce. Tighten per-file once each area
        // is brought up.
        perFile: false,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});