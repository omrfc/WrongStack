import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    pack: 'src/pack.ts',
    host: 'src/host.ts',
    vision: 'src/vision.ts',
    clipboard: 'src/clipboard.ts',
    probe: 'src/local-llm-probe.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2023',
  external: ['@wrongstack/core'],
});
