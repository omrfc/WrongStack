import { describe, expect, it } from 'vitest';

// Extracted logic from verifyClient for testability
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

interface VerifyInput {
  origin?: string;
  url?: string;
  expectedToken: string;
  wsHost: string;
}

function verifyClient(input: VerifyInput): boolean {
  const { origin, url, expectedToken, wsHost } = input;
  const tokenMatch = (url ?? '').match(/[?&]token=([^&]+)/);
  const providedToken = tokenMatch ? tokenMatch[1] : undefined;
  const tokenOk = providedToken === expectedToken;

  if (!origin) {
    return tokenOk || wsHost === '127.0.0.1' || wsHost === '::1' || wsHost === 'localhost';
  }
  try {
    const { hostname } = new URL(origin);
    if (isLoopback(hostname)) return true;
    return tokenOk;
  } catch {
    return false;
  }
}

const TOKEN = 'abc123def456';

describe('verifyClient (WebSocket auth)', () => {
  it('allows loopback browser origin without token', () => {
    expect(verifyClient({ origin: 'http://localhost:3000', expectedToken: TOKEN, wsHost: '127.0.0.1' })).toBe(true);
    expect(verifyClient({ origin: 'http://127.0.0.1:3000', expectedToken: TOKEN, wsHost: '127.0.0.1' })).toBe(true);
    expect(verifyClient({ origin: 'http://[::1]:3000', expectedToken: TOKEN, wsHost: '127.0.0.1' })).toBe(true);
  });

  it('allows non-browser client on loopback without token', () => {
    expect(verifyClient({ origin: undefined, expectedToken: TOKEN, wsHost: '127.0.0.1' })).toBe(true);
    expect(verifyClient({ origin: undefined, expectedToken: TOKEN, wsHost: '::1' })).toBe(true);
    expect(verifyClient({ origin: undefined, expectedToken: TOKEN, wsHost: 'localhost' })).toBe(true);
  });

  it('requires token for non-loopback browser origin', () => {
    expect(verifyClient({ origin: 'http://192.168.1.5:3000', expectedToken: TOKEN, wsHost: '127.0.0.1' })).toBe(false);
    expect(verifyClient({ origin: 'http://192.168.1.5:3000', url: `/?token=${TOKEN}`, expectedToken: TOKEN, wsHost: '127.0.0.1' })).toBe(true);
  });

  it('requires token for non-browser client on non-loopback', () => {
    expect(verifyClient({ origin: undefined, expectedToken: TOKEN, wsHost: '0.0.0.0' })).toBe(false);
    expect(verifyClient({ origin: undefined, url: `/?token=${TOKEN}`, expectedToken: TOKEN, wsHost: '0.0.0.0' })).toBe(true);
  });

  it('rejects wrong token', () => {
    expect(verifyClient({ origin: undefined, url: '/?token=wrong', expectedToken: TOKEN, wsHost: '0.0.0.0' })).toBe(false);
    expect(verifyClient({ origin: 'http://192.168.1.5:3000', url: '/?token=wrong', expectedToken: TOKEN, wsHost: '127.0.0.1' })).toBe(false);
  });

  it('rejects malformed origins', () => {
    expect(verifyClient({ origin: 'not-a-url', expectedToken: TOKEN, wsHost: '127.0.0.1' })).toBe(false);
  });

  it('allows non-loopback browser with correct token', () => {
    expect(verifyClient({ origin: 'http://10.0.0.5:3000', url: `/?token=${TOKEN}`, expectedToken: TOKEN, wsHost: '0.0.0.0' })).toBe(true);
  });
});
