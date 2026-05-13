import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/tests/**',
        '**/dist/**',
        'packages/*/src/index.ts',
        '**/types/**',
        // CLI entry points — require interactive TTY, not testable in unit context
        'packages/cli/src/input-reader.ts',
        'packages/cli/src/repl.ts',
        'packages/cli/src/spinner.ts',
        // React browser components — require DOM/puppeteer environment
        'packages/tui/src/app.tsx',
        'packages/tui/src/components/file-picker.tsx',
        'packages/tui/src/components/input.tsx',
        'packages/tui/src/components/slash-menu.tsx',
      ],
      thresholds: {
        lines: 80,
        functions: 82,
        branches: 65,
        statements: 80,
      },
    },
  },
});
