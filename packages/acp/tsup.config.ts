import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client/index.ts',
    agent: 'src/agent/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2023',
  // Externalize every @wrongstack/* workspace package. Previously this
  // was an empty array, so tsup inlined @wrongstack/core into every
  // dist entry. That produced THREE separate copies of core at runtime
  // (one per entry), each with its own logger/config/event-bus
  // singletons — a subtle correctness bug. The regex covers new
  // workspace deps automatically.
  external: [/^@wrongstack\//],
});