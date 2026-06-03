import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hostHeaderOk,
  isLoopbackHostname,
  tokenMatches,
  verifyClient,
} from '../../src/server/ws-auth.js';

const TOKEN = 'abc123def456';
// A loopback Host header — required for the DNS-rebinding guard to pass on a
// loopback bind. Real same-machine browsers send this.
const LOOPBACK_HOST = '127.0.0.1:3456';

describe('verifyClient (WebSocket auth)', () => {
  it('allows loopback browser origin without token (loopback bind)', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(
        verifyClient({
          origin,
          url: '/',
          hostHeader: LOOPBACK_HOST,
          wsHost: '127.0.0.1',
          expectedToken: TOKEN,
        }),
      ).toBe(true);
    }
  });

  it('allows non-browser client on a loopback bind without token', () => {
    for (const wsHost of ['127.0.0.1', '::1', 'localhost']) {
      expect(
        verifyClient({
          url: '/',
          hostHeader: LOOPBACK_HOST,
          remoteAddress: '127.0.0.1',
          wsHost,
          expectedToken: TOKEN,
        }),
      ).toBe(true);
    }
  });

  it('requires a token for a non-loopback browser origin', () => {
    const base = { hostHeader: LOOPBACK_HOST, wsHost: '127.0.0.1', expectedToken: TOKEN } as const;
    expect(verifyClient({ origin: 'http://192.168.1.5:3000', url: '/', ...base })).toBe(false);
    expect(
      verifyClient({ origin: 'http://192.168.1.5:3000', url: `/?token=${TOKEN}`, ...base }),
    ).toBe(true);
  });

  it('denies a LAN non-browser client on a public (0.0.0.0) bind, even with a token', () => {
    // The 0.0.0.0 branch denies a non-loopback peer outright — a token does not
    // rescue it. Documents the stricter-than-it-looks policy.
    expect(
      verifyClient({
        url: '/',
        remoteAddress: '192.168.1.5',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
    expect(
      verifyClient({
        url: `/?token=${TOKEN}`,
        remoteAddress: '192.168.1.5',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it('allows a loopback-peer non-browser client on a public bind only with a token', () => {
    const base = { remoteAddress: '127.0.0.1', wsHost: '0.0.0.0', expectedToken: TOKEN } as const;
    expect(verifyClient({ url: '/', ...base })).toBe(false);
    expect(verifyClient({ url: `/?token=${TOKEN}`, ...base })).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(
      verifyClient({
        url: '/?token=wrong',
        remoteAddress: '127.0.0.1',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
    expect(
      verifyClient({
        origin: 'http://192.168.1.5:3000',
        url: '/?token=wrong',
        hostHeader: LOOPBACK_HOST,
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it('rejects a malformed origin', () => {
    expect(
      verifyClient({
        origin: 'not-a-url',
        url: '/',
        hostHeader: LOOPBACK_HOST,
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it('allows a non-loopback browser with the correct token on a public bind', () => {
    expect(
      verifyClient({
        origin: 'http://10.0.0.5:3000',
        url: `/?token=${TOKEN}`,
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(true);
  });

  it('rejects DNS-rebinding: a non-loopback Host on a loopback bind', () => {
    // Loopback origin + attacker-controlled Host header → the rebinding guard
    // fires before the origin check, so this is rejected.
    expect(
      verifyClient({
        origin: 'http://localhost:3000',
        url: '/',
        hostHeader: 'evil.com:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
    // Missing Host header on a loopback bind is likewise rejected.
    expect(
      verifyClient({
        origin: 'http://localhost:3000',
        url: '/',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });
});

describe('hostHeaderOk (DNS-rebinding guard)', () => {
  it('accepts a loopback Host on a loopback bind', () => {
    for (const hostHeader of ['127.0.0.1:3456', 'localhost:3000', '[::1]:3456']) {
      expect(hostHeaderOk({ hostHeader, wsHost: '127.0.0.1' })).toBe(true);
    }
  });

  it('rejects a non-loopback or missing Host on a loopback bind', () => {
    expect(hostHeaderOk({ hostHeader: 'evil.com:3456', wsHost: '127.0.0.1' })).toBe(false);
    expect(hostHeaderOk({ hostHeader: '', wsHost: '127.0.0.1' })).toBe(false);
    expect(hostHeaderOk({ hostHeader: undefined, wsHost: '127.0.0.1' })).toBe(false);
  });

  it('skips the guard on a public (non-loopback) bind', () => {
    expect(hostHeaderOk({ hostHeader: 'evil.com:3456', wsHost: '0.0.0.0' })).toBe(true);
    expect(hostHeaderOk({ hostHeader: undefined, wsHost: '0.0.0.0' })).toBe(true);
  });
});

describe('tokenMatches (constant-time compare)', () => {
  it('matches the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  });
  it('rejects a wrong, missing, or length-mismatched token', () => {
    expect(tokenMatches('wrong-token!', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches('short', TOKEN)).toBe(false); // length mismatch short-circuit
  });
});

describe('isLoopbackHostname', () => {
  it('recognizes loopback names', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });
  it('rejects non-loopback names', () => {
    for (const h of ['192.168.1.5', '10.0.0.5', 'evil.com', '0.0.0.0']) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});

// ─── HTTP static file path traversal guard ──────────────────────────────────
// Extracted from webui/src/server/index.ts for unit testing.

function isPathSafe(urlPathname: string, distDir: string): boolean {
  const filePath = path.join(distDir, urlPathname);
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(distDir);
  return resolvedPath.startsWith(resolvedRoot + path.sep) || resolvedPath === resolvedRoot;
}

describe('HTTP static file path traversal guard', () => {
  const DIST = path.resolve('/app/dist');

  it('allows normal paths inside dist', () => {
    expect(isPathSafe('/index.html', DIST)).toBe(true);
    expect(isPathSafe('/assets/main.js', DIST)).toBe(true);
    expect(isPathSafe('/assets/css/style.css', DIST)).toBe(true);
  });

  it('blocks basic dot-dot traversal', () => {
    expect(isPathSafe('/../../../etc/passwd', DIST)).toBe(false);
    expect(isPathSafe('/assets/../../etc/passwd', DIST)).toBe(false);
  });

  it('blocks percent-encoded dot-dot traversal (after URL decoding)', () => {
    // In the real server, new URL() decodes %2e%2e to .. before path.join.
    // Simulate that by decoding first, then checking.
    const decoded = '/../../../etc/passwd'; // what new URL('/%2e%2e/...') produces
    expect(isPathSafe(decoded, DIST)).toBe(false);
  });

  it('blocks paths that resolve outside dist via intermediate traversal', () => {
    expect(isPathSafe('/assets/../../../etc/shadow', DIST)).toBe(false);
  });

  it('allows root path', () => {
    expect(isPathSafe('/', DIST)).toBe(true);
  });
});

// ─── Rate limiter ───────────────────────────────────────────────────────────
// Extracted from cli/src/webui-server.ts for unit testing.

function createRateLimiter(maxMsgs: number, windowMs: number) {
  let msgCount = 0;
  let windowResetAt = Date.now() + windowMs;
  return {
    check(): boolean {
      const now = Date.now();
      if (now > windowResetAt) {
        msgCount = 0;
        windowResetAt = now + windowMs;
      }
      if (++msgCount > maxMsgs) return false;
      return true;
    },
  };
}

describe('WebSocket rate limiter', () => {
  it('allows messages within limit', () => {
    const limiter = createRateLimiter(3, 60_000);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
  });

  it('blocks messages exceeding limit', () => {
    const limiter = createRateLimiter(2, 60_000);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(false);
  });

  it('resets after window expires', () => {
    // Use a very short window (1ms) that expires between checks
    const limiter = createRateLimiter(1, 1);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(false);
    // Busy-wait for window to expire (1ms)
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(limiter.check()).toBe(true);
  });
});
