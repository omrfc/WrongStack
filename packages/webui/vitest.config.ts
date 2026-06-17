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
      // Updated 2026-06-17 (after ui-store + chat-store 100%):
      //   stmts 16.86% · branches 14.06% · funcs 15.07% · lines n/a (v8).
      // Updated 2026-06-17 (after file/history/session/config-store tests):
      //   stmts 17.55% · branches 14.54% · funcs 16.84% · lines 18.13%.
      // Current: stmts ~18.5 · branches ~16 · funcs ~17.7 · lines ~19.2.
      // fleet-store: 71.68% → 91.15% stmts (new tests: 13 → 38).
      // Stores at 100%: goal-store, file-store, history-store, session-store,
      // viz-store, fleet-store (91%). local-prefs at 31.25% (zustand/persist).
      // Biggest gaps: server/index.ts (3.6k LOC), SkillsPanel/AgentFlowCanvas/ChatInput.
      thresholds: {
        statements: 18,
        branches: 16,
        functions: 17,
        lines: 19,
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
      // Force @wrongstack/core to resolve from source (packages/core/src) instead
      // of going through the package's "exports" field which points to dist/.
      '@wrongstack/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
});