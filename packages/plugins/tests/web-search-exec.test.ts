import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

import webSearchPlugin from '../src/web-search';

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface RespOpts {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: string;
  location?: string | null;
}
function resp(o: RespOpts = {}): unknown {
  const status = o.status ?? 200;
  return {
    ok: o.ok ?? (status >= 200 && status < 300),
    status,
    statusText: o.statusText ?? 'OK',
    text: async () => o.body ?? '',
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? (o.location ?? null) : null) },
  };
}

const fetchMock = vi.fn();

function setup(extensions: Record<string, unknown> = {}): { tools: Record<string, Tool>; metrics: { counter: ReturnType<typeof vi.fn> } } {
  const tools: Record<string, Tool> = {};
  const metrics = { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() };
  const api = {
    tools: { register: (t: Tool) => { tools[t.name] = t; } },
    config: { extensions },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics,
  };
  webSearchPlugin.setup(api as never);
  return { tools, metrics };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue([{ address: '8.8.8.8' }]); // public by default
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// DuckDuckGo HTML fixture with two results (one duplicate-ish, one relative).
function ddgHtml(): string {
  return `
    <a class="result__a" href="https://example.com/a?utm=1">Title <b>One</b></a>
    <a class="result__snippet">Snippet about cats</a>
    <a class="result__a" href="https://example.com/a#frag">Title One Dup</a>
    <a class="result__snippet">Different snippet</a>
    <a class="result__a" href="https://other.org/b">Dogs Page</a>
    <a class="result__snippet">All about dogs</a>
    <a class="result__a" href="/relative/path">Relative</a>
    <a class="result__snippet">skipped, not http</a>
  `;
}

describe('web_search', () => {
  it('rejects an empty query', async () => {
    const { tools } = setup();
    const res = await tools.web_search!.execute({ query: '   ' });
    expect(res).toMatchObject({ ok: false, results: [] });
  });

  it('searches, dedups by normalized URL, drops non-http, ranks, and caches', async () => {
    fetchMock.mockResolvedValue(resp({ body: ddgHtml() }));
    const { tools, metrics } = setup();
    const res = await tools.web_search!.execute({ query: 'cats', numResults: 10 });
    expect(res.ok).toBe(true);
    expect(res.cached).toBe(false);
    const results = res.results as Array<{ url: string }>;
    // example.com/a (deduped to one), other.org/b — relative dropped
    expect(results.map((r) => r.url)).toEqual([
      'https://example.com/a?utm=1',
      'https://other.org/b',
    ]);
    expect(metrics.counter).toHaveBeenCalledWith('cache_miss', 1, expect.anything());
  });

  it('ranks a title match above a snippet-only match', async () => {
    fetchMock.mockResolvedValue(resp({ body: ddgHtml() }));
    const { tools } = setup();
    // 'dogs' appears in the title "Dogs Page" (+2) and snippet "All about dogs" (+1).
    const res = await tools.web_search!.execute({ query: 'dogs' });
    const results = res.results as Array<{ url: string; score: number }>;
    expect(results[0]?.url).toBe('https://other.org/b');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('serves a cached result on the second identical query', async () => {
    fetchMock.mockResolvedValue(resp({ body: ddgHtml() }));
    const { tools, metrics } = setup();
    await tools.web_search!.execute({ query: 'cats' });
    const second = await tools.web_search!.execute({ query: 'cats' });
    expect(second.cached).toBe(true);
    expect((second.results as Array<{ cached: boolean }>)[0]?.cached).toBe(true);
    expect(metrics.counter).toHaveBeenCalledWith('cache_hit', 1, expect.anything());
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
  });

  it('skips the cache when skipCache is set', async () => {
    fetchMock.mockResolvedValue(resp({ body: ddgHtml() }));
    const { tools } = setup();
    await tools.web_search!.execute({ query: 'cats' });
    await tools.web_search!.execute({ query: 'cats', skipCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns ok:false when the search engine fails', async () => {
    fetchMock.mockResolvedValue(resp({ ok: false, status: 503, statusText: 'busy' }));
    const { tools } = setup();
    const res = await tools.web_search!.execute({ query: 'cats' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Search failed/);
  });

  it('prunes stale cache entries on a later miss', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    fetchMock.mockResolvedValue(resp({ body: ddgHtml() }));
    const { tools } = setup({ 'web-search': { cacheTtlMs: 1000 } });
    await tools.web_search!.execute({ query: 'first' });
    // Jump well past cacheTtlMs*2 so the prune branch deletes the stale entry.
    vi.setSystemTime(10_000);
    await tools.web_search!.execute({ query: 'second' });
    // 'first' is now pruned → re-querying it misses (fetch called again).
    await tools.web_search!.execute({ query: 'first' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('web_fetch', () => {
  it('rejects a missing or non-string url', async () => {
    const { tools } = setup();
    expect((await tools.web_fetch!.execute({})).ok).toBe(false);
    expect((await tools.web_fetch!.execute({ url: 123 })).ok).toBe(false);
  });

  it('rejects a non-http(s) url before fetching', async () => {
    const { tools } = setup();
    const res = await tools.web_fetch!.execute({ url: 'ftp://example.com' });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/http/);
  });

  it('fetches and converts HTML to markdown', async () => {
    fetchMock.mockResolvedValue(resp({
      body: '<html><head><style>x{}</style><script>bad()</script></head><body><h1>Hi</h1><p>Para &amp; more</p><br>line</body></html>',
    }));
    const { tools } = setup();
    const res = await tools.web_fetch!.execute({ url: 'https://example.com/page' });
    expect(res.ok).toBe(true);
    const content = res.content as string;
    expect(content).toContain('## Hi');
    expect(content).toContain('Para & more');
    expect(content).not.toContain('bad()');
    expect(content).not.toContain('<script');
  });

  it('returns plain text when format=text', async () => {
    fetchMock.mockResolvedValue(resp({ body: 'raw text body' }));
    const { tools } = setup();
    const res = await tools.web_fetch!.execute({ url: 'https://example.com', format: 'text' });
    expect(res.content).toBe('raw text body');
  });

  it('follows a redirect, re-validating the new location', async () => {
    fetchMock
      .mockResolvedValueOnce(resp({ status: 302, location: 'https://example.com/final' }))
      .mockResolvedValueOnce(resp({ body: 'final body' }));
    const { tools } = setup();
    const res = await tools.web_fetch!.execute({ url: 'https://example.com/start', format: 'text' });
    expect(res.content).toBe('final body');
    expect(dns.lookup).toHaveBeenCalledTimes(2); // both hops validated
  });

  it('errors after too many redirects', async () => {
    fetchMock.mockResolvedValue(resp({ status: 302, location: 'https://example.com/loop' }));
    const { tools } = setup();
    const res = await tools.web_fetch!.execute({ url: 'https://example.com/start' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Too many redirects/);
  });

  it('errors on a redirect with no location header', async () => {
    fetchMock.mockResolvedValue(resp({ status: 302, location: null }));
    const { tools } = setup();
    const res = await tools.web_fetch!.execute({ url: 'https://example.com/start' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to fetch/);
  });

  it('errors on a non-ok response', async () => {
    fetchMock.mockResolvedValue(resp({ ok: false, status: 404, statusText: 'Not Found' }));
    const { tools } = setup();
    const res = await tools.web_fetch!.execute({ url: 'https://example.com/missing' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/404/);
  });

  it('rejects a redirect to an unsupported protocol', async () => {
    fetchMock.mockResolvedValueOnce(resp({ status: 302, location: 'ftp://example.com/x' }));
    const { tools } = setup();
    const res = await tools.web_fetch!.execute({ url: 'https://example.com/start' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unsupported protocol/);
  });

  describe('SSRF guard', () => {
    it('blocks localhost', async () => {
      const { tools } = setup();
      const res = await tools.web_fetch!.execute({ url: 'http://localhost/x' });
      expect(res.error).toMatch(/localhost/);
    });

    it('blocks a literal private IPv4', async () => {
      const { tools } = setup();
      const res = await tools.web_fetch!.execute({ url: 'http://127.0.0.1/x' });
      expect(res.error).toMatch(/private|loopback/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks a literal private IPv6', async () => {
      const { tools } = setup();
      const res = await tools.web_fetch!.execute({ url: 'http://[::1]/x' });
      expect(res.error).toMatch(/private|loopback/);
    });

    it('blocks a hostname that resolves to a private address', async () => {
      dns.lookup.mockResolvedValue([{ address: '10.0.0.5' }]);
      const { tools } = setup();
      const res = await tools.web_fetch!.execute({ url: 'https://intranet.example' });
      expect(res.error).toMatch(/private|loopback/);
    });

    it('errors when the hostname cannot be resolved', async () => {
      dns.lookup.mockRejectedValue(new Error('ENOTFOUND'));
      const { tools } = setup();
      const res = await tools.web_fetch!.execute({ url: 'https://nope.invalid' });
      expect(res.error).toMatch(/Could not resolve host/);
    });
  });
});
