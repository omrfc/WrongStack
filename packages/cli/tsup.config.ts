import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2023',
  banner: { js: '#!/usr/bin/env node' },
  // Externalize every @wrongstack/* workspace package so a single shared
  // copy of each is loaded at runtime. The previous explicit list missed
  // acp, plug-lsp, runtime, telegram, tui, and webui — bundling them
  // inline duplicated @wrongstack/core in the dist, breaking the
  // singleton contract that the cross-package event bus and config
  // paths depend on. The regex picks up new workspace deps automatically.
  external: [/^@wrongstack\//, 'ws'],
});
