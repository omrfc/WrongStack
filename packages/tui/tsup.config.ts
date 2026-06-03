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
  // Externalize every @wrongstack/* workspace package (single shared
  // copy of core/runtime/tools at runtime) plus ink + react which
  // tsup cannot bundle because they have native/JSX runtime concerns.
  external: [/^@wrongstack\//, 'ink', 'react'],
});
