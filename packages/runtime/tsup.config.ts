import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/pack.ts', 'src/host.ts', 'src/vision.ts', 'src/clipboard.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2023',
  external: ['@wrongstack/core'],
});
