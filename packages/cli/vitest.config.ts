import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Force @wrongstack/core to resolve from source (packages/core/src) instead
      // of going through the package's "exports" field which points to dist/.
      '@wrongstack/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // hq-dashboard.test.ts requires jsdom environment which the forks pool
      // may fail to resolve from the global vitest binary. Run it separately.
      'tests/hq-dashboard.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Hermes ~/.wrongstack: redirect global state to per-worker temp dir so
    // tests never read the user's real config or leak fixture project dirs.
    setupFiles: ['../../vitest.setup.ts'],
    // Cap fork workers to prevent spawn-heavy tests from starving.
    maxWorkers: '25%',
  },
});
