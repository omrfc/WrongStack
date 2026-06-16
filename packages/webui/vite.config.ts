import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@wrongstack\/core\/utils\/expect-defined$/,
        replacement: path.resolve(__dirname, '../core/src/utils/expect-defined.ts'),
      },
      {
        find: /^@wrongstack\/core\/execution\/prompt-enhancer$/,
        replacement: path.resolve(__dirname, '../core/src/execution/prompt-enhancer.ts'),
      },
      {
        find: /^@wrongstack\/core\/utils\/error$/,
        replacement: path.resolve(__dirname, '../core/src/utils/error.ts'),
      },
      // Browser-only: redirect the bare `@wrongstack/core` barrel (which drags
      // in Node built-ins) to a tiny browser-safe shim. Exact match only, so
      // subpath imports like `@wrongstack/core/storage` are left untouched.
      {
        find: /^@wrongstack\/core$/,
        replacement: path.resolve(__dirname, './src/lib/core-browser-shim.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  server: {
    port: 3456,
    host: '127.0.0.1',
    // NOTE: `server.headers` applies to the DEV server only — the production
    // CSP lives in src/server/http-server.ts (buildCspHeader) and stays
    // strict. Dev needs two relaxations:
    //   - script-src 'unsafe-inline': @vitejs/plugin-react injects an inline
    //     react-refresh preamble into index.html; `script-src 'self'` blocked
    //     it and the app crashed at boot with "can't detect preamble".
    //   - connect-src ws://…:* — ports auto-advance when 3456/3457 are taken
    //     (multiple instances), so pinning :3457 blocked the backend WS.
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://[::1]:* wss://[::1]:*",
        "worker-src 'self' blob:",
        "font-src 'self' data:",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          return id.includes('node_modules') ? 'vendor' : undefined;
        },
      },
    },
  },
  define: {
    // NODE_ENV is set by Vite; 'development' only when in dev mode.
    // In production builds this resolves to false, keeping dev-only
    // code paths inactive in the browser bundle.
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development'),
  },
});
