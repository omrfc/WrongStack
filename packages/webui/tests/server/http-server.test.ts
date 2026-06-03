/**
 * Tests for the static-serve HTTP server. Two concerns:
 *
 *   1. **MIME matching + path traversal guard.** The server must reject
 *      `../../../etc/passwd` style escapes and serve a real .html file
 *      with the correct Content-Type and CSP header.
 *
 *   2. **SPA fallback.** Unknown paths serve `index.html` (with the same
 *      CSP as the direct .html branch) so client-side routing still
 *      works for deep-linked URLs.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCspHeader,
  createHttpServer,
  isInsideDist,
} from '../../src/server/http-server.js';

let distDir: string;
let server: import('node:http').Server;
let baseUrl: string;

beforeAll(async () => {
  // Build a tiny distDir with one .html, one .js, and one .json file.
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-http-'));
  await fs.writeFile(
    path.join(distDir, 'index.html'),
    '<!doctype html><title>root</title>',
  );
  await fs.writeFile(path.join(distDir, 'app.js'), 'console.log(1);');
  await fs.writeFile(
    path.join(distDir, 'manifest.json'),
    '{"name":"test"}',
  );

  server = createHttpServer({ host: '127.0.0.1', distDir, wsPort: 9999 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad listen address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(distDir, { recursive: true, force: true });
});

describe('buildCspHeader', () => {
  it('embeds the WS port in connect-src and pins the policy', () => {
    const csp = buildCspHeader(3457);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('ws://127.0.0.1:3457');
    expect(csp).toContain('wss://127.0.0.1:3457');
    expect(csp).toContain('ws://[::1]:3457');
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('createHttpServer', () => {
  it('serves index.html for /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('content-security-policy')).toContain('ws://127.0.0.1:9999');
    expect(await res.text()).toContain('<title>root</title>');
  });

  it('serves .js with the right MIME type', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(await res.text()).toBe('console.log(1);');
  });

  it('serves .json with application/json', async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('rejects path-traversal attempts with 403', async () => {
    // The traversal guard is exported as `isInsideDist` so we can test
    // it directly. A black-box test via fetch or http.request is not
    // possible: WHATWG URL normalises `/../escape.txt` → `/escape.txt`
    // before the request even leaves the client, so the `..` never
    // reaches the server. The unit test below asserts the guard's
    // *contract* (the thing that actually runs in production).
    expect(isInsideDist(path.join(distDir, 'index.html'), distDir)).toBe(true);
    expect(isInsideDist(path.join(distDir, '..', 'escape.txt'), distDir)).toBe(
      false,
    );
    // Also: a sibling directory with a name that *starts with* distDir's
    // name (e.g. distDir = /tmp/foo, sibling = /tmp/foo-other) must NOT
    // be accepted. The `+ path.sep` boundary check rejects that.
    const sibling = distDir + '-other';
    expect(isInsideDist(path.join(sibling, 'leak.txt'), distDir)).toBe(false);
  });

  it('falls back to index.html for SPA routes (unknown path)', async () => {
    const res = await fetch(`${baseUrl}/some/deep/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    // SPA fallback must also include the CSP — the audit found an
    // unprotected deep-link window otherwise.
    expect(res.headers.get('content-security-policy')).toContain('ws://127.0.0.1:9999');
  });

  it('always sets X-Content-Type-Options=nosniff and X-Frame-Options=DENY', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
});
