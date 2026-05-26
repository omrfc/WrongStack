import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    postcss: './postcss.config.cjs',
  },
  server: {
    port: 3456,
    host: '127.0.0.1',
    headers: {
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self' ws://127.0.0.1:3457 wss://127.0.0.1:3457",
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
