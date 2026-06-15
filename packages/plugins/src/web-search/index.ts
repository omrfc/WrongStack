/**
 * web-search plugin — Cached web search with deduplication and ranking.
 *
 * Tools registered:
 * - web_search: Search the web with caching and deduplication
 * - web_fetch: Fetch a URL and return content as markdown
 */
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import type { Plugin } from '@wrongstack/core';
import { isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core';

const API_VERSION = '^0.1.10';

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  score: number;
  source: string;
  cached: boolean;
}

interface CacheEntry {
  results: SearchResult[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Simple search engine implementations
// ---------------------------------------------------------------------------

async function duckduckgoSearch(query: string, numResults: number): Promise<SearchResult[]> {
  // Use DuckDuckGo's HTML interface (no API key required)
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WrongStack/1.0; +https://wrongstack.com)',
    },
  });

  if (!resp.ok) throw new Error(`DuckDuckGo search failed: ${resp.status}`);

  const html = await resp.text();

  // Parse results from DuckDuckGo HTML
  const results: SearchResult[] = [];
  const resultRe = /<a class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: while-loop condition requires assignment
  while ((m = resultRe.exec(html)) !== null && results.length < numResults) {
    const url = m[1];
    /* v8 ignore next -- regex capture group 1 ([^"]+) is always non-empty when matched; defensive. */
    if (!url) continue;
    /* v8 ignore next -- group 2 is always defined on a match; the ?? '' fallback is defensive. */
    const title = (m[2] ?? '').replace(/<[^>]+>/g, '').trim();
    /* v8 ignore next -- group 3 is always defined on a match; the ?? '' fallback is defensive. */
    const snippet = (m[3] ?? '').replace(/<[^>]+>/g, '').trim();
    results.push({
      url,
      title,
      snippet,
      score: 1,
      source: 'duckduckgo',
      cached: false,
    });
  }

  return results;
}

function assertSafeIp(ip: string): void {
  if (isIPv4(ip) && isPrivateIPv4(ip)) {
    throw new Error(`Blocked private/loopback address: ${ip}`);
  }
  if (isIPv6(ip) && isPrivateIPv6(ip)) {
    throw new Error(`Blocked private/loopback address: ${ip}`);
  }
}

/**
 * SSRF guard. Validates the scheme, blocks literal private/loopback hosts
 * (IPv4 and IPv6, including IPv4-mapped IPv6 and cloud-metadata addresses),
 * and — critically — resolves the hostname via DNS and rejects if ANY
 * resolved address is private. Called on the initial URL and re-called on
 * every redirect hop so a 302 to http://169.254.169.254 cannot bypass it.
 */
async function assertSafeUrl(rawUrl: string): Promise<void> {
  const u = new URL(rawUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${u.protocol}`);
  }
  const host =
    u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '' || host === '0.0.0.0') {
    throw new Error('Blocked localhost target');
  }
  // Literal IP target: validate directly.
  if (isIPv4(host) || isIPv6(host)) {
    assertSafeIp(host);
    return;
  }
  // Hostname: resolve and reject if any address is private (defeats a name
  // that points at an internal IP). Note: a TOCTOU window remains since the
  // global fetch() re-resolves; acceptable for this single-tenant convenience
  // tool, and redirect hops are re-validated below.
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  for (const { address } of addrs) assertSafeIp(address);
}

async function fetchUrl(url: string, format: 'markdown' | 'text'): Promise<string> {
  // Manual redirect handling: re-validate every hop against the SSRF guard so
  // an external site cannot redirect us onto an internal/metadata endpoint.
  const MAX_REDIRECTS = 5;
  let currentUrl = url;
  let resp: Response | undefined;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertSafeUrl(currentUrl);
    resp = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WrongStack/1.0; +https://wrongstack.com)',
        Accept: format === 'text' ? 'text/plain' : 'text/html',
      },
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) break;
      currentUrl = new URL(loc, currentUrl).toString();
      if (i === MAX_REDIRECTS) throw new Error('Too many redirects');
      continue;
    }
    break;
  }
  /* v8 ignore next -- the loop runs at least once and always assigns resp; defensive guard. */
  if (!resp) throw new Error(`Failed to fetch ${url}`);

  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);

  if (format === 'text') {
    return resp.text();
  }

  // Convert HTML to markdown
  let html = await resp.text();
  // Simple HTML to markdown conversion
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, t) => `\n## ${t.trim()}\n`);
  html = html.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `${t.trim()}\n\n`);
  html = html.replace(/<br\s*\/?>/gi, '\n');
  html = html.replace(/<[^>]+>/g, '');
  html = html.replace(/&amp;/g, '&');
  html = html.replace(/&lt;/g, '<');
  html = html.replace(/&gt;/g, '>');
  html = html.replace(/&quot;/g, '"');
  html = html.replace(/&#39;/g, "'");
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim().slice(0, 50000); // cap at 50k chars
}

function scoreResults(results: SearchResult[], query: string): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/);
  return results
    .map((r) => {
      const titleLower = r.title.toLowerCase();
      const snippetLower = r.snippet.toLowerCase();
      let score = r.score;
      for (const term of terms) {
        if (titleLower.includes(term)) score += 2;
        if (snippetLower.includes(term)) score += 1;
      }
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'web-search',
  version: '0.1.0',
  description: 'Cached web search with deduplication and relevance ranking',
  apiVersion: API_VERSION,
  capabilities: { tools: true, pipelines: ['request'] },
  defaultConfig: {
    cacheTtlMs: 300_000,
    maxResults: 10,
    userAgent: 'WrongStack/1.0',
  },
  configSchema: {
    type: 'object',
    properties: {
      cacheTtlMs: { type: 'number', default: 300_000 },
      maxResults: { type: 'number', default: 10 },
      userAgent: { type: 'string', default: 'WrongStack/1.0' },
    },
  },

  setup(api) {
    const cache = new Map<string, CacheEntry>();
    const cacheTtlMs = (api.config.extensions?.['web-search'] as Record<string, unknown>)?.['cacheTtlMs'] as number ?? 300_000;
    const maxResults = (api.config.extensions?.['web-search'] as Record<string, unknown>)?.['maxResults'] as number ?? 10;

    // --- web_search tool ---
    api.tools.register({
      name: 'web_search',
      description: 'Search the web using DuckDuckGo with automatic caching and deduplication. Results are cached for faster subsequent queries.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          numResults: { type: 'number', default: 10, description: 'Maximum number of results' },
          source: { type: 'string', enum: ['duckduckgo'], default: 'duckduckgo', description: 'Search engine' },
          skipCache: { type: 'boolean', default: false, description: 'Skip cache and force fresh search' },
        },
        required: ['query'],
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        const query = input['query'];
        if (!query || typeof query !== 'string' || query.trim() === '') {
          return { ok: false, error: 'query is required and must be a non-empty string', results: [] };
        }
        const numResults = (input['numResults'] as number | undefined) ?? maxResults;
        const skipCache = (input['skipCache'] as boolean | undefined) ?? false;

        // Check cache
        if (!skipCache) {
          const cached = cache.get(query);
          if (cached && Date.now() - cached.timestamp < cacheTtlMs) {
            const results = cached.results.map((r) => ({ ...r, cached: true }));
            api.metrics.counter('cache_hit', 1, { query: query.slice(0, 20) });
            return {
              ok: true,
              query,
              cached: true,
              results: results.slice(0, numResults),
              count: results.length,
            };
          }
        }

        api.metrics.counter('cache_miss', 1, { query: query.slice(0, 20) });

        // Deduplicate URL tracking
        const seenUrls = new Set<string>();

        let rawResults: SearchResult[];
        try {
          rawResults = await duckduckgoSearch(query, numResults * 2);
        } catch (err: unknown) {
          /* v8 ignore next -- duckduckgoSearch only throws Error; the String(err) branch is defensive. */
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `Search failed: ${msg}`, results: [] };
        }

        // Deduplicate by URL
        const deduplicated: SearchResult[] = [];
        for (const r of rawResults) {
          /* v8 ignore next -- split() always yields ≥1 element; the ?? r.url fallback is defensive. */
          const noQuery = r.url.split('?')[0] ?? r.url;
          /* v8 ignore next -- split() always yields ≥1 element; the ?? r.url fallback is defensive. */
          const normalized = noQuery.split('#')[0] ?? r.url;
          if (!seenUrls.has(normalized) && r.url.startsWith('http')) {
            seenUrls.add(normalized);
            deduplicated.push(r);
          }
        }

        // Rank results
        const ranked = scoreResults(deduplicated, query);

        // Cache
        cache.set(query, { results: ranked, timestamp: Date.now() });

        // Prune old cache entries
        const now = Date.now();
        for (const [key, entry] of cache.entries()) {
          if (now - entry.timestamp > cacheTtlMs * 2) cache.delete(key);
        }

        return {
          ok: true,
          query,
          cached: false,
          results: ranked.slice(0, numResults),
          count: ranked.length,
        };
      },
    });

    // --- web_fetch tool ---
    api.tools.register({
      name: 'web_fetch',
      description: 'Fetch a URL and return its content as markdown or plain text.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri', description: 'URL to fetch' },
          format: { type: 'string', enum: ['markdown', 'text'], default: 'markdown' },
        },
        required: ['url'],
      },
      permission: 'confirm',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const rawUrl = input['url'];
        if (!rawUrl || typeof rawUrl !== 'string') {
          return { ok: false, error: 'url is required and must be a string' };
        }
        const url = rawUrl as string;
        const format = (input['format'] as 'markdown' | 'text') ?? 'markdown';

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return { ok: false, error: 'URL must start with http:// or https://' };
        }

        let content: string;
        try {
          content = await fetchUrl(url, format);
        } catch (err: unknown) {
          /* v8 ignore next -- fetchUrl only throws Error; the String(err) branch is defensive. */
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: msg };
        }

        return {
          ok: true,
          url,
          format,
          contentLength: content.length,
          content: content.slice(0, 20000),
          truncated: content.length > 20000,
        };
      },
    });

    api.log.info('web-search plugin loaded', { version: '0.1.0', cacheTtlMs });
  },
};

export default plugin;