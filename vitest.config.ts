import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The `@` alias is webui-only (no other package uses it). Mapping it here lets
  // webui tests picked up by this root config (packages/**/tests/**) resolve
  // `@/...` imports the same way the webui Vite/vitest configs do.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './packages/webui/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/tests/**/*.test.ts'],
    exclude: [
        '**/node_modules/**',
        '**/dist/**',
      ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.bench.ts',
        '**/tests/**',
        '**/dist/**',
        // grep.ts — ripgrep-specific code (rg detection, runRgStream, parseRgCountLine).
        // rg is not present on Windows by default; the entire rg path is unreachable
        // in standard CI. The native walk() path is well-tested.
        'packages/tools/src/grep.ts',
        // _env.ts — backward-compat re-export, no runnable code.
        'packages/tools/src/_env.ts',
        'packages/*/src/index.ts',
        '**/types/**',
        // Test helpers — only exist to support tests, not production code
        'packages/*/src/test-helpers/**',
        // CLI entry points — require interactive TTY, not testable in unit context
        'packages/cli/src/input-reader.ts',
        'packages/cli/src/repl.ts',
        'packages/cli/src/spinner.ts',
        // React/ink components — require DOM/ink-testing-library
        'packages/tui/src/app.tsx',
        'packages/tui/src/components/**/*.tsx',
        'packages/tui/src/hooks/**/*.ts',
        // TUI app state — state machine with side effects; integration-tested end-to-end
        'packages/tui/src/app-reducer.ts',
        // TUI entry/runtime — Ink render-tree wiring, exercised end-to-end
        'packages/tui/src/run-tui.ts',
        // Clipboard — depends on OS-level pasteboards (xsel/pbcopy/clip.exe)
        'packages/tui/src/clipboard.ts',
        // Runtime pack.ts is a pure TypeScript interface file — no runnable code
        'packages/runtime/src/pack.ts',
        // WebUI browser-only modules — require jsdom/jsdom-like environment
        'packages/webui/src/lib/chime.ts',
        'packages/webui/src/lib/favicon.ts',
        'packages/webui/src/lib/notify.ts',
        'packages/webui/src/lib/utils.ts',
        'packages/webui/src/lib/ws-client.ts',
        // WebUI React components
        'packages/webui/src/components/**/*.tsx',
        'packages/webui/src/hooks/**/*.ts',
        'packages/webui/src/stores/**/*.ts',
        // WebUI server entry points (require WebSocket/binding)
        'packages/webui/src/server/index.ts',
        'packages/webui/src/server/entry.ts',
        // LSP search — requires a live language server; integration-tested separately
        'packages/plug-lsp/src/tools/codebase-lsp-search.ts',
        'packages/plug-lsp/src/tools/lsp-search.ts',
        // Codebase index — requires real filesystem + sqlite; integration tested
        'packages/plug-lsp/src/tools/codebase-index/index.ts',
        // Tools shim — thin sqlite wrapper; exercised via integration tests
        'packages/tools/src/shim/**/*.ts',
        // Language parsers — external-language support tested via integration
        'packages/plug-lsp/src/auto-doc/ts-parser.ts',
        'packages/plug-lsp/src/auto-doc/rs-parser.ts',
        'packages/plug-lsp/src/auto-doc/go-parser.ts',
        'packages/plug-lsp/src/auto-doc/py-parser.ts',
        'packages/plug-lsp/src/auto-doc/sh-parser.ts',
      ],
      // Coverage thresholds — calibrated to achievable coverage.
      //
      // Achievable coverage analysis (after exclusions above):
      //   - core, cli, providers, plugins: ~85–90% with effort (complex streaming,
      //     runtime config, pipeline hooks)
      //   - tools: ~78% (tools/src/shim excluded, grep.ts excluded)
      //   - plug-lsp: ~70% (LSP tools and index excluded from unit coverage)
      //
      // Global: 72% lines is achievable with targeted tests.
      // 100% requires DOM/jsdom for webui/tui and LSP stubs for plug-lsp.
      thresholds: {
        // Floor: 68% statements, 58% branches — must not regress.
        // Raise by 1% as each new test file lands.
        lines: 70,
        functions: 70,
        branches: 58,
        statements: 68,
      },
    },
  },
});
