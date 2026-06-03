/**
 * WebSocket connection authentication for the WebUI server.
 *
 * Three layered defenses, all enforced in {@link verifyClient}:
 *  1. **DNS-rebinding guard** ({@link hostHeaderOk}) — on a loopback bind the
 *     `Host` header must itself be a loopback name, so a rebound attacker page
 *     (`Host: evil.com`) is rejected even though its TCP peer is 127.0.0.1.
 *  2. **Shared-token auth** ({@link tokenMatches}, constant-time) — required for
 *     any non-loopback origin and for non-browser clients reaching a publicly
 *     bound socket.
 *  3. **Loopback bootstrap** — same-machine browser origins are allowed without
 *     a token (the token is delivered in `session.start` and replayed on
 *     reconnect); the Host-header guard above already blocks cross-site pages.
 *
 * Extracted from `index.ts` as pure functions so the auth contract can be unit
 * tested without standing up a real `http.Server`/`WebSocketServer`. `index.ts`
 * builds a thin closure that pulls the fields below off the incoming request.
 */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

/** A hostname that refers to the local machine. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/** True when the server is bound to a loopback interface (vs. LAN/0.0.0.0). */
export function isLoopbackBind(wsHost: string): boolean {
  return wsHost === '127.0.0.1' || wsHost === '::1' || wsHost === 'localhost';
}

/**
 * Constant-time comparison of a provided token against the expected one.
 * A length mismatch short-circuits (lengths aren't secret); equal-length
 * inputs are compared with `timingSafeEqual` so the token can't be recovered
 * byte-by-byte via response timing.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the `token` query param out of a request URL (`/?token=…`). */
export function extractToken(url: string): string | undefined {
  const match = url.match(/[?&]token=([^&]+)/);
  return match ? match[1] : undefined;
}

/**
 * DNS-rebinding defense. On a loopback bind, the `Host` header must resolve to
 * a loopback name. When the operator deliberately exposes the socket (wsHost is
 * a LAN/0.0.0.0 address) the Host is legitimately non-loopback, so the guard is
 * skipped and connection auth falls to the token check.
 */
export function hostHeaderOk(input: { hostHeader: string | undefined; wsHost: string }): boolean {
  if (!isLoopbackBind(input.wsHost)) return true; // operator opted into wider exposure
  const hostHeader = (input.hostHeader ?? '').trim();
  if (!hostHeader) return false;
  // Strip the port (handle bare host, host:port, and [::1]:port).
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname);
}

export interface VerifyClientInput {
  /** Browser `Origin` header, or undefined for non-browser clients. */
  origin?: string;
  /** Request URL (`req.url`) — carries the `?token=…` query param. */
  url: string;
  /** `Host` header (`req.headers.host`). */
  hostHeader?: string;
  /** Peer address (`req.socket.remoteAddress`). */
  remoteAddress?: string;
  /** Host/interface the WS server is bound to. */
  wsHost: string;
  /** The server's generated auth token. */
  expectedToken: string;
}

/**
 * Decide whether to accept an incoming WebSocket handshake. Pure mirror of the
 * closure previously inlined in `index.ts`; see the module doc for the layered
 * policy. Returns `true` to accept, `false` to reject.
 */
export function verifyClient(input: VerifyClientInput): boolean {
  const { origin, url, hostHeader, remoteAddress, wsHost, expectedToken } = input;
  const tokenOk = tokenMatches(extractToken(url ?? ''), expectedToken);

  // DNS-rebinding guard runs first on a loopback bind — independent of token
  // and Origin. Blocks a rebound attacker page (Host = attacker domain) even
  // though the TCP peer is 127.0.0.1.
  if (!hostHeaderOk({ hostHeader, wsHost })) return false;

  if (!origin) {
    // Non-browser clients (curl, scripts): require token unless on loopback.
    // When wsHost=0.0.0.0 the server accepts connections from any network
    // interface — a non-loopback peer is denied outright.
    const remoteIp = remoteAddress ?? '';
    const isRemoteLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1';
    if (!isRemoteLoopback && wsHost === '0.0.0.0') return false; // LAN exposure = deny
    return tokenOk || isLoopbackBind(wsHost);
  }
  try {
    const { hostname } = new URL(origin);
    // Loopback browser origins: allow without token (bootstrap). The Host-header
    // guard above already rejects cross-site/rebinding pages here.
    if (isLoopbackHostname(hostname)) return true;
    // Non-loopback origins: token is mandatory.
    return tokenOk;
  } catch {
    return false;
  }
}
