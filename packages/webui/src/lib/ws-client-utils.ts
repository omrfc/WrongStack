import type { WSServerMessage } from '../types';

export type EventHandler = (msg: WSServerMessage) => void;

export interface PendingConfirm {
  resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
}

export type WsStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; error?: string | undefined }
  | { state: 'reconnecting'; attempt: number; nextRetryAt: number; lastError?: string | undefined };

/**
 * Read `?token=…` from the WS URL the client was constructed with.
 * Used by the cookie bootstrap (`ensureAuthCookie`) — when the server
 * prints the WS URL to its startup banner (e.g. `ws://127.0.0.1:3457?token=…`)
 * the page is loaded with the token in the URL, the client reads it
 * here, hits `/ws-auth?token=…` to swap it for an HttpOnly cookie, and
 * the cookie carries forward on every reconnect. There is no
 * persistent client-side store of the token.
 */
export function getTokenFromWsUrl(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    return u.searchParams.get('token');
  } catch {
    return null;
  }
}

const DEFAULT_WS_PORT = 3457;

export function resolveWsPort(): number {
  if (typeof document === 'undefined') return DEFAULT_WS_PORT;
  const raw = document
    .querySelector('meta[name="wrongstack-ws-port"]')
    ?.getAttribute('content');
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_WS_PORT;
}

export function defaultWsUrl(): string {
  const port = resolveWsPort();
  if (typeof window === 'undefined' || !window.location?.hostname) {
    return `ws://127.0.0.1:${port}`;
  }
  const host = window.location.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return `ws://127.0.0.1:${port}`;
  }
  return `ws://${window.location.hostname}:${port}`;
}

/**
 * Derive the HTTP origin for `/ws-auth` from the page's own location.
 * `/ws-auth` is a same-origin HTTP call, so we use the page's host
 * (NOT the WS port). The same `loopback→127.0.0.1` DNS-dance fix from
 * `defaultWsUrl()` applies — on Windows, browsers resolve `localhost`
 * to `[::1]` first, so we force IPv4 loopback for cookie consistency.
 */
export function httpOriginForAuth(): string {
  if (typeof window === 'undefined' || !window.location?.hostname) {
    return 'http://127.0.0.1:3456';
  }
  const host = window.location.hostname.toLowerCase();
  const pagePort = window.location.port
    ? Number.parseInt(window.location.port, 10)
    : Number.NaN;
  const httpPort = Number.isFinite(pagePort) && pagePort > 0 ? pagePort : 3456;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return `http://127.0.0.1:${httpPort}`;
  }
  return `http://${window.location.hostname}:${httpPort}`;
}
