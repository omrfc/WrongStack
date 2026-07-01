import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { main: 'src/main/main.ts', 'agent-bridge': 'src/main/agent-bridge.ts' },
    format: ['esm'],
    target: 'es2024',
    platform: 'node',
    outDir: 'dist/main',
    clean: true,
    sourcemap: true,
    external: ['electron'],
  },
  {
    entry: { preload: 'src/main/preload.ts', 'webui-preload': 'src/main/webui-preload.ts' },
    format: ['cjs'],
    target: 'es2024',
    platform: 'node',
    outDir: 'dist/preload',
    clean: true,
    sourcemap: true,
    outExtension: () => ({ js: '.cjs' }),
    external: ['electron'],
  },
]);
