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
  external: ['@wrongstack/core', '@wrongstack/providers', '@wrongstack/tools', '@wrongstack/mcp'],
});
