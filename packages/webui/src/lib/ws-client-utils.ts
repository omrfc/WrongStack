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

export function getTokenFromPageUrl(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  try {
    const search = window.location.search ?? '';
    return new URLSearchParams(search).get('token');
  } catch {
    return null;
  }
}

export function stripTokenFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete('token');
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function stripTokenFromAddressBar(): void {
  if (typeof window === 'undefined' || !window.location || !window.history?.replaceState) return;
  try {
    const href = window.location.href;
    if (!href) return;
    const url = new URL(href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, document.title, url.toString());
  } catch {
    /* best-effort only */
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

export function resolvePublicWsUrl(): string | null {
  if (typeof document === 'undefined') return null;
  const raw = document
    .querySelector('meta[name="wrongstack-ws-url"]')
    ?.getAttribute('content')
    ?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    const token = getTokenFromPageUrl();
    if (token && !url.searchParams.has('token')) {
      url.searchParams.set('token', token);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function defaultWsUrl(): string {
  const publicWsUrl = resolvePublicWsUrl();
  if (publicWsUrl) return publicWsUrl;
  const port = resolveWsPort();
  if (typeof window === 'undefined' || !window.location?.hostname) {
    return `ws://127.0.0.1:${port}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname.toLowerCase();
  const token = getTokenFromPageUrl();
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return `${protocol}://127.0.0.1:${port}${query}`;
  }
  return `${protocol}://${window.location.hostname}:${port}${query}`;
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
  const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
  const host = window.location.hostname.toLowerCase();
  const portSuffix = window.location.port ? `:${window.location.port}` : '';
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return `${protocol}://127.0.0.1${portSuffix}`;
  }
  return `${protocol}://${window.location.hostname}${portSuffix}`;
}
