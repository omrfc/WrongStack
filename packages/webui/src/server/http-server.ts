/**
 * Static-file HTTP server for the WebUI React frontend.
 *
 * - Serves files from `distDir` (typically `<webui>/dist`).
 * - Returns `index.html` for any unknown path so client-side routing works
 *   (SPA fallback) — and applies the same Content-Security-Policy to that
 *   fallback as to a direct `.html` response, so deep-linked routes are
 *   not unprotected.
 * - **Path-traversal guard**: `path.join` alone does NOT prevent
 *   `%2e%2e%2f` escapes (the `URL` constructor decodes percent-encoding
 *   before we see the path). We re-`resolve` the candidate and verify it
 *   stays under `distDir`.
 * - **CSP**: `connect-src` uses explicit loopback addresses for the WS
 *   server (not bare `ws:` / `wss:`) so a malicious page script cannot
 *   dial an attacker-controlled WebSocket. Combined with token-in-URL
 *   (C-2), this prevents cross-origin WS abuse.
 *
 * Extracted from `index.ts` so the static-serve concern can be tested
 * with a tiny fake `distDir` and asserted on path-traversal, MIME
 * matching, and CSP header presence.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';

export interface CreateHttpServerOptions {
  /** Port to listen on. Defaults to 3456 (or the `PORT` env var). */
  port?: number;
  /** Host/interface to bind. Typically the loopback for the WebUI. */
  host: string;
  /** Resolved path to the directory containing the built React assets. */
  distDir: string;
  /**
   * WS port — appears in the CSP `connect-src` directive so the browser
   * is allowed to open a WebSocket back to the local server.
   */
  wsPort: number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Build the Content-Security-Policy value for the given WS port. */
export function buildCspHeader(wsPort: number): string {
  return (
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ` +
    `connect-src 'self' ws://127.0.0.1:${wsPort} wss://127.0.0.1:${wsPort} ` +
    `ws://[::1]:${wsPort} wss://[::1]:${wsPort}; ` +
    `img-src 'self' data:; font-src 'self' data:; object-src 'none'; ` +
    `base-uri 'self'; frame-ancestors 'none'; form-action 'self'`
  );
}

/**
 * Returns true when `candidate` (a fully-resolved absolute path) lies
 * strictly inside `distDir` (or equals it). Used to reject path-traversal
 * attempts after `path.resolve` has normalised any `..` segments.
 *
 * Exported so tests can assert the guard's contract without having to
 * also defeat the WHATWG URL normaliser (which strips `..` from the
 * path string *before* the request even reaches the server, making a
 * black-box test via fetch impossible).
 */
export function isInsideDist(candidate: string, distDir: string): boolean {
  const root = path.resolve(distDir);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Create the static-file HTTP server. Returns the `http.Server` (not
 * listening yet) so the caller can attach to a `shutdown()` hook and
 * coordinate the listen() with the WebSocket bootstrap.
 */
export function createHttpServer(opts: CreateHttpServerOptions): http.Server {
  const port = opts.port ?? Number.parseInt(process.env['PORT'] ?? '3456', 10);
  const distDir = path.resolve(opts.distDir);
  const wsPort = opts.wsPort;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      let filePath: string;

      if (url.pathname === '/' || url.pathname === '') {
        filePath = path.join(distDir, 'index.html');
      } else if (url.pathname.startsWith('/assets/')) {
        filePath = path.join(distDir, url.pathname);
      } else if (url.pathname.startsWith('/')) {
        filePath = path.join(distDir, url.pathname);
      } else {
        filePath = path.join(distDir, 'index.html');
      }

      // Path traversal guard: the resolved path must stay inside distDir.
      // WHATWG URL leaves percent-encoding alone in `url.pathname` (it
      // does not decode `%2e%2e` to `..`), so percent-encoded escapes
      // are *not* a concern here — but unencoded `..` segments are
      // normalised by `path.resolve` and would walk the candidate up
      // out of distDir. `isInsideDist` catches that.
      const resolvedPath = path.resolve(filePath);
      if (!isInsideDist(resolvedPath, distDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const ext = path.extname(resolvedPath);
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      if (ext === '.html') {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Security-Policy', buildCspHeader(wsPort));
      }

      const fileContent = await fs.readFile(resolvedPath);
      res.writeHead(200);
      res.end(fileContent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // SPA fallback: serve index.html so client-side routing still works.
        try {
          const fileContent = await fs.readFile(path.join(distDir, 'index.html'));
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Content-Security-Policy': buildCspHeader(wsPort),
          });
          res.end(fileContent);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    }
  });
}
