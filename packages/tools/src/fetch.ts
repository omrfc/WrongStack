import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core';
import { Agent } from 'undici';
import TurndownService from 'turndown';
import { truncateMiddle } from './_util.js';

/**
 * Singleton Turndown instance for HTML→Markdown conversion.
 * Pre-configured with sensible defaults; code blocks are handled via the
 * default fenced code rule. Reused across all fetch calls.
 */
const TD = new TurndownService({
  // Use `# Title` for headings, not setext underline style (`Title\n=====`).
  headingStyle: 'atx',
  // Don't wrap code blocks in <pre> — render them as triple-backtick blocks.
  codeBlockStyle: 'fenced',
});

// Strip <script>/<style>/<noscript> before turndown sees them. The old
// hand-rolled converter did this via regex; turndown's DOM-based approach
// may keep their text content unless we remove the elements first.
// Using turndown's own addRule mechanism keeps the logic co-located.
TD.addRule('stripDangerousElements', {
  filter: ['script', 'style', 'noscript'],
  replacement: () => '',
});

interface FetchInput {
  url: string;
  format?: 'markdown' | 'text' | 'raw' | undefined;
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
/* v8 ignore next 8 -- module-load-time opt-in warning; gated on an env var not set during tests. */
if (ALLOW_PRIVATE && !process.env['CI']) {
  console.warn(
    '[WrongStack] WARNING: WRONGSTACK_FETCH_ALLOW_PRIVATE=1 is active —\n' +
    '  fetch tool can now access private IPs (10.x, 192.168.x, 169.254.x),\n' +
    '  cloud metadata endpoints, and plaintext HTTP. Use only on isolated networks.',
  );
}

/** Abort when any of the signals abort (Node 22+ — AbortSignal.any shipped in Node 20). */
const combineSignals = (signals: AbortSignal[]): AbortSignal => AbortSignal.any(signals);

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string | undefined; family: number }>,
  family?: number | undefined,
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
export function guardedLookup(
  hostname: string,
  options: { all?: boolean | undefined; family?: number | undefined },
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
      const first = list.at(0);
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
// Destroyed on process exit so long-running processes (eternal autonomy,
// MCP server mode) don't let the connection pool grow unboundedly.
let pinnedAgent: Agent | undefined;
function getPinnedDispatcher(): Agent {
  if (!pinnedAgent) {
    pinnedAgent = new Agent({ connect: { lookup: guardedLookup as never } });
  }
  return pinnedAgent;
}
// Clean up the global dispatcher on exit — undici Agents maintain connection
// pools and DNS caches that should be torn down in long-running processes.
// Guard against duplicate registration (module reload/HMR would otherwise
// accumulate listeners).
let _beforeExitRegistered = false;
if (!_beforeExitRegistered) {
  _beforeExitRegistered = true;
  /* v8 ignore next 4 -- process 'beforeExit' cleanup; not deterministically triggerable in-test. */
  process.on('beforeExit', () => {
    pinnedAgent?.destroy();
    pinnedAgent = undefined;
  });
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
    const res = await fetch(currentUrl, init as never as RequestInit);
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
  description:
    'Fetch a URL and return its content. HTML pages are automatically converted to clean markdown. ' +
    'This tool has strong SSRF protections (private IPs, localhost, and cloud metadata endpoints are blocked by default).',
  usageHint:
    'Use this when you need external information (documentation, API responses, web pages, etc.).\n\n' +
    'Security notes:\n' +
    '- Only HTTPS is allowed by default.\n' +
    '- Internal/private networks are blocked unless explicitly enabled via environment variable.\n' +
    '- Redirects are followed but re-validated at each hop.\n' +
    '- Output is capped (128KB by default) to avoid flooding context.\n' +
    'Prefer this over raw `bash curl` or `bash wget`.',
  permission: 'confirm',
  mutating: false,
  capabilities: ['net.outbound'],
  icon: 'web',
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
      url: {
        type: 'string',
        description: 'The target URL (must use https://).',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'raw'],
        description: 'Output format. "markdown" is recommended for HTML pages.',
      },
    },
    required: ['url'],
  },
  async execute(input, ctx, opts) {
    let final: FetchOutput | undefined;
    const executeStream = fetchTool.executeStream;
    if (!executeStream) throw new Error('fetchTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
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
    const combined = combineSignals([opts.signal, ctrl.signal]);

    try {
      let res: Response;
      try {
        res = await guardedFetch(input.url, 5, combined);
      } catch (err) {
        // A user-initiated cancel propagates unchanged. Our own timeout and any
        // transport failure get a diagnostic message: undici throws an opaque
        // `TypeError: fetch failed` whose real reason (ENOTFOUND, ECONNREFUSED,
        // UND_ERR_CONNECT_TIMEOUT, a TLS/cert error, …) lives only on `.cause`.
        // Surfacing just `.message` left users with "fetch failed" and no clue
        // why HTTPS broke (see #100), so unwrap the cause chain here.
        if (opts.signal.aborted) throw err;
        throw describeFetchError(err, input.url, ctrl.signal.aborted);
      }

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
            const recent = Buffer.from(value).toString('utf-8');
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
      else if (format === 'markdown' && ct.includes('text/html')) content = TD.turndown(text);
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
      // Use dns.lookup for async hostname resolution (matches guardedLookup below).
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

/**
 * Turn an opaque undici `TypeError: fetch failed` into an actionable message by
 * walking its `.cause` chain. undici buries the transport reason (a DNS/socket
 * errno or a TLS handshake failure) one or more `.cause` hops down, so the bare
 * `.message` is always just "fetch failed". We join each distinct
 * `code: message` link so the user sees, e.g.,
 * `fetch: GET https://x failed — UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error`.
 */
function describeFetchError(err: unknown, url: string, timedOut: boolean): Error {
  if (timedOut) {
    return new Error(`fetch: GET ${url} timed out after ${TIMEOUT_MS}ms`);
  }
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as NodeJS.ErrnoException).code;
    const label = code ? `${code}: ${cur.message}` : cur.message;
    // Skip undici's uninformative top-level "fetch failed" wrapper, but keep it
    // as a fallback if it turns out to be the only thing we have.
    if (label && label !== 'fetch failed' && !parts.includes(label)) parts.push(label);
    cur = (cur as { cause?: unknown }).cause;
  }
  const detail = parts.length > 0 ? parts.join(' → ') : 'fetch failed';
  return new Error(`fetch: GET ${url} failed — ${detail}`);
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

