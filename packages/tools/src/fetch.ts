import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { Agent } from 'undici';
import { truncateMiddle } from './_util.js';

interface FetchInput {
  url: string;
  format?: 'markdown' | 'text' | 'raw';
}

interface FetchOutput {
  content: string;
  status: number;
  content_type: string;
  url: string;
}

const MAX_BYTES = 131_072;
const TIMEOUT_MS = 20_000;

const ALLOW_PRIVATE = process.env['WRONGSTACK_FETCH_ALLOW_PRIVATE'] === '1';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * DNS lookup used by the undici dispatcher below. It performs the SINGLE name
 * resolution that the TCP connection actually uses, and rejects if any
 * resolved address is private/loopback/link-local. Because the connection
 * reuses exactly this result, there is no DNS-rebinding TOCTOU window between
 * the security check and the connect — closing the gap the old code documented
 * (validate with one dns.lookup, then let fetch re-resolve independently).
 * TLS still validates the certificate against the hostname (SNI is set by
 * undici from the URL), so pinning the IP does not weaken cert checking.
 */
function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
): void {
  dns
    .lookup(hostname, { all: true })
    .then((records) => {
      const family = options?.family;
      const byFamily =
        family === 4 || family === 6 ? records.filter((r) => r.family === family) : records;
      const list = byFamily.length > 0 ? byFamily : records;
      if (!ALLOW_PRIVATE) {
        for (const r of list) {
          const bad = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
          if (bad) {
            callback(
              Object.assign(new Error(`fetch: resolved to private address ${r.address}`), {
                code: 'EAI_FAIL',
              }),
            );
            return;
          }
        }
      }
      if (options?.all) {
        callback(
          null,
          list.map((r) => ({ address: r.address, family: r.family })),
        );
        return;
      }
      const first = list[0];
      if (!first) {
        callback(
          Object.assign(new Error(`fetch: no address for ${hostname}`), { code: 'ENOTFOUND' }),
        );
        return;
      }
      callback(null, first.address, first.family);
    })
    .catch((err) => callback(err as NodeJS.ErrnoException));
}

// Reused across requests; guardedLookup re-validates on every new connection,
// so connection pooling is safe. Literal-IP targets bypass lookup entirely and
// are caught by assertNotPrivate's pre-check instead.
let pinnedAgent: Agent | undefined;
function getPinnedDispatcher(): Agent {
  if (!pinnedAgent) {
    pinnedAgent = new Agent({ connect: { lookup: guardedLookup as never } });
  }
  return pinnedAgent;
}

/**
 * SSRF-guarded fetch with manual, per-hop-revalidated redirects, exported so
 * other builtin tools (e.g. `search`) get the same protections instead of a
 * weaker `redirect: 'follow'`. Every hop is re-checked against private/loopback
 * ranges and the connection is pinned to the validated IP via the undici
 * dispatcher (no DNS-rebinding TOCTOU). `headers` defaults to the plain `fetch`
 * tool's; callers may override (e.g. a browser User-Agent for search engines).
 */
export async function guardedFetch(
  url: string,
  maxRedirects: number,
  signal: AbortSignal,
  headers: Record<string, string> = {
    'user-agent': 'WrongStack/1.0 (+https://wrongstack.com)',
    accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
  },
): Promise<Response> {
  let redirectCount = 0;
  let currentUrl = url;
  for (;;) {
    // Re-validate every hop. A public host can 302 to 169.254.169.254 (cloud metadata),
    // or DNS can rebind between hops; checking only the initial URL is insufficient.
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`fetch: redirect to unsupported protocol "${parsed.protocol}"`);
    }
    if (parsed.protocol === 'http:' && !ALLOW_PRIVATE) {
      throw new Error('fetch: redirect to http:// blocked (HTTPS required by default)');
    }
    await assertNotPrivate(parsed.hostname);

    // The dispatcher pins the connection to the IP guardedLookup validated —
    // no independent re-resolution, so DNS rebinding can't swap in a private
    // address between check and connect. `dispatcher` is a runtime option of
    // Node's undici-backed global fetch but isn't in lib.dom's RequestInit, and
    // our undici Agent's type differs from the @types/node copy — hence the
    // cast. (Verified: global fetch invokes the Agent's custom lookup.)
    const init = {
      redirect: 'manual' as const,
      signal,
      headers,
      dispatcher: getPinnedDispatcher(),
    };
    const res = await fetch(currentUrl, init as unknown as RequestInit);
    if (res.status < 300 || res.status > 399) {
      return res;
    }
    redirectCount++;
    if (redirectCount > maxRedirects) {
      throw new Error(`fetch: exceeded ${maxRedirects} redirects`);
    }
    const location = res.headers.get('location');
    if (!location) {
      throw new Error('fetch: redirect status with no location header');
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}

export const fetchTool: Tool<FetchInput, FetchOutput> = {
  name: 'fetch',
  category: 'Network',
  description: 'Fetch the contents of a URL. HTML is converted to markdown by default.',
  usageHint:
    'HTTPS only by default. Localhost and RFC1918 ranges blocked unless WRONGSTACK_FETCH_ALLOW_PRIVATE=1. Max 5 redirects, 20s timeout, 128KB cap.',
  permission: 'confirm',
  mutating: false,
  // Trust rules for fetch match on the literal URL — declare it explicitly
  // so a user can trust `https://api.example.com/*` without accidentally
  // matching that pattern on any other tool that happens to have a `url`
  // input field.
  subjectKey: 'url',
  timeoutMs: TIMEOUT_MS,
  maxOutputBytes: MAX_BYTES,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      format: { type: 'string', enum: ['markdown', 'text', 'raw'] },
    },
    required: ['url'],
  },
  async execute(input, ctx, opts) {
    let final: FetchOutput | undefined;
    for await (const ev of fetchTool.executeStream!(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('fetch: stream ended without final event');
    return final;
  },
  async *executeStream(input, _ctx, opts): AsyncGenerator<ToolStreamEvent<FetchOutput>> {
    if (!input?.url) throw new Error('fetch: url is required');
    const u = new URL(input.url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error(`fetch: unsupported protocol "${u.protocol}"`);
    }
    if (u.protocol === 'http:' && !ALLOW_PRIVATE) {
      throw new Error('fetch: http:// blocked (HTTPS required by default)');
    }
    await assertNotPrivate(u.hostname);

    yield { type: 'log', text: `GET ${input.url}` };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('fetch timeout')), TIMEOUT_MS);
    const combined = combineSignals(opts.signal, ctrl.signal);

    try {
      const res = await guardedFetch(input.url, 5, combined);

      const ct = res.headers.get('content-type') ?? 'application/octet-stream';
      if (/^image\/|^audio\/|^video\/|application\/octet-stream/.test(ct)) {
        throw new Error(`fetch: refusing to read binary content-type "${ct}"`);
      }

      yield {
        type: 'log',
        text: `HTTP ${res.status} ${ct}`,
        data: { status: res.status, contentType: ct },
      };

      const reader = res.body?.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      let pendingBytes = 0;
      const FLUSH_AT = 4 * 1024;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          pendingBytes += value.byteLength;
          chunks.push(value);
          if (pendingBytes >= FLUSH_AT) {
            // Snapshot recent bytes for the partial_output. Keep it cheap —
            // don't try to decode UTF-8 boundaries; the TUI just needs a
            // "things are happening" signal.
            const recent = Buffer.from(value).toString('utf8');
            yield {
              type: 'partial_output',
              text: recent,
              data: { received },
            };
            pendingBytes = 0;
          }
          if (received > MAX_BYTES) break;
        }
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');

      const format = input.format ?? (ct.includes('text/html') ? 'markdown' : 'text');
      let content: string;
      if (format === 'raw') content = text;
      else if (format === 'markdown' && ct.includes('text/html')) content = htmlToMarkdown(text);
      else if (ct.includes('application/json')) content = prettyJson(text);
      else content = text;

      yield {
        type: 'final',
        output: {
          content: truncateMiddle(content, MAX_BYTES),
          status: res.status,
          content_type: ct,
          url: res.url,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

async function assertNotPrivate(hostname: string): Promise<void> {
  if (ALLOW_PRIVATE) return;

  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('fetch: blocked localhost target');
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    if (isPrivateIPv4(host)) {
      throw new Error(`fetch: blocked private/loopback address "${host}"`);
    }
  } else if (ipVersion === 6) {
    if (isPrivateIPv6(host)) {
      throw new Error(`fetch: blocked private/loopback address "${host}"`);
    }
  } else {
    // Hostname — pre-flight check: resolve and reject if any record is private,
    // so we fail fast with a clear error before opening a socket. The
    // authoritative anti-rebinding control is guardedLookup on the pinned
    // undici dispatcher (see getPinnedDispatcher): it performs the single
    // resolution the connection actually uses, so there is no TOCTOU between
    // this check and the connect. Each redirect target is re-checked too.
    try {
      const records = await dns.lookup(host, { all: true });
      for (const r of records) {
        const bad = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
        if (bad) {
          throw new Error(`fetch: resolved to private address ${r.address}`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('fetch:')) throw err;
      // DNS failure — let fetch handle it
    }
  }
}

function isPrivateIPv4(addr: string): boolean {
  // net.isIP rejects octal/hex/decimal forms, so when isIP(addr) === 4 we
  // know it's canonical dotted-quad and safe to parse this way.
  const parts = addr.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // defensive
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + AWS/GCE/Azure IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // Convert to 8-group canonical form (16 hex words) so range checks
  // don't have to handle every shortening notation. Returns null on
  // anything we can't normalize; we conservatively return true in that
  // case so a parser surprise blocks rather than leaks.
  const groups = expandIPv6(lower);
  if (!groups) return true;
  // IPv4-mapped: ::ffff:0:0/96 → groups[0..5] all 0, groups[6..7] hold the
  // embedded IPv4 as two 16-bit words. Node URL normalizes the dotted form
  // to this representation (e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1).
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const a = (groups[6] ?? 0) >> 8;
    const b = (groups[6] ?? 0) & 0xff;
    const c = (groups[7] ?? 0) >> 8;
    const d = (groups[7] ?? 0) & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }
  const high = groups[0] ?? 0;
  if ((high & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (fc..fd)
  if ((high & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((high & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Expand an IPv6 string into exactly 8 16-bit numbers. Handles `::`
 * compression. Returns null on malformed input — caller should treat that
 * as "block".
 */
function expandIPv6(addr: string): number[] | null {
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g.length === 0 || g.length > 4) return null;
      const n = Number.parseInt(g, 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
      out.push(n);
    }
    return out;
  };
  if (parts.length === 1) {
    const groups = parseGroups(parts[0] ?? '');
    if (!groups || groups.length !== 8) return null;
    return groups;
  }
  const head = parseGroups(parts[0] ?? '');
  const tail = parseGroups(parts[1] ?? '');
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function combineSignals(...sigs: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return (AbortSignal as { any: (s: AbortSignal[]) => AbortSignal }).any(sigs);
  }
  // Fallback for older runtimes. We register listeners on the parent signals
  // and clean them up once any of them fires (or once ctrl itself aborts) to
  // avoid accumulating handlers on long-lived signals across many fetches.
  const ctrl = new AbortController();
  const cleanups: Array<() => void> = [];
  const detach = () => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  };
  for (const s of sigs) {
    if (s.aborted) {
      detach();
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    const onAbort = () => {
      detach();
      ctrl.abort(s.reason);
    };
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }
  ctrl.signal.addEventListener('abort', detach, { once: true });
  return ctrl.signal;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function htmlToMarkdown(html: string): string {
  let s = html;
  // Strip scripts/styles
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // Headings
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, c) => {
    return '\n' + '#'.repeat(Number(n)) + ' ' + stripTags(c).trim() + '\n';
  });
  // Bold / italic
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  // Links — only emit markdown links for safe protocols
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const safe = /^(https?|ftps?):\/\//i.test(href);
    return safe ? `[${text}](${href})` : text;
  });
  // Code
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, c) => '\n```\n' + stripTags(c) + '\n```\n');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // Lists
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  // Breaks / paragraphs
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  // Strip remaining tags
  s = stripTags(s);
  // Decode common entities
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
