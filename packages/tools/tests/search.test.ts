import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchTool } from '../src/search.js';

/**
 * Mocked-fetch tests for the search tool.
 *
 * The previous version of this file hit live DuckDuckGo/Google/Bing — which
 * timed out at 5s on CI runners and turned the search suite into a coin flip.
 * We mock `globalThis.fetch` instead. Mocking at the fetch boundary keeps the
 * test exercising the same parsing + bounds-clamping code paths the real
 * tool runs, without the network dependency.
 */

const makeOpts = () => ({ signal: new AbortController().signal });

const DDG_FIXTURE = `
<html><body>
<a class="result-link" href="https://example.com/1">Example One</a>
<a class="result-snippet">Snippet for example one</a>
<a class="result-link" href="https://example.com/2">Example Two</a>
<a class="result-snippet">Snippet for example two</a>
</body></html>
`;

const GOOGLE_FIXTURE = `
<html><body>
<div class="g">
  <a href="/url?q=https://example.com/g1&amp;sa=U">Google Hit One</a>
  <div class="VwiC3b">Google snippet one</div>
</div>
</body></html>
`;

const BING_FIXTURE = `
<html><body>
<li class="b_algo">
  <h2><a href="https://example.com/b1">Bing Hit One</a></h2>
  <p>Bing snippet one</p>
</li>
</body></html>
`;

function mockFetch(htmlForUrl: (url: string) => string) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = url instanceof Request ? url.url : url.toString();
    return new Response(htmlForUrl(u), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });
}

describe('searchTool', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch((u) => {
      if (u.includes('duckduckgo')) return DDG_FIXTURE;
      if (u.includes('google')) return GOOGLE_FIXTURE;
      if (u.includes('bing')) return BING_FIXTURE;
      return '';
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct metadata', () => {
    expect(searchTool.name).toBe('search');
    expect(searchTool.permission).toBe('confirm');
    expect(searchTool.inputSchema.required).toContain('query');
  });

  it('throws when query is missing', async () => {
    const ctx = {} as any;
    await expect(searchTool.execute({} as any, ctx, makeOpts())).rejects.toThrow();
  });

  it('throws for unknown source', async () => {
    const ctx = {} as any;
    await expect(
      searchTool.execute({ query: 'test', source: 'unknown' as any }, ctx, makeOpts()),
    ).rejects.toThrow();
  });

  it('defaults to duckduckgo', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test' }, ctx, makeOpts());
    expect(result.source).toBe('duckduckgo');
  });

  it('respects num_results bounds', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 5 }, ctx, makeOpts());
    expect(result.query).toBe('test');
  });

  it('caps num_results at MAX_RESULTS', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 999 }, ctx, makeOpts());
    expect(result.results).toBeDefined();
  });

  it('uses google source', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', source: 'google' }, ctx, makeOpts());
    expect(result.source).toBe('google');
  });

  it('uses bing source', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', source: 'bing' }, ctx, makeOpts());
    expect(result.source).toBe('bing');
  });

  it('has truncated flag', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 1 }, ctx, makeOpts());
    expect(typeof result.truncated).toBe('boolean');
  });

  it('returns results array', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test' }, ctx, makeOpts());
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('throws when executeStream is unavailable', async () => {
    const original = searchTool.executeStream;
    searchTool.executeStream = undefined;
    try {
      await expect(searchTool.execute({ query: 'x' }, {} as any, makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      searchTool.executeStream = original;
    }
  });

  it('throws when the stream ends without a final event', async () => {
    const original = searchTool.executeStream!;
    searchTool.executeStream = async function* () {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(searchTool.execute({ query: 'x' }, {} as any, makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      searchTool.executeStream = original;
    }
  });
});

describe('search engine parsers (realistic fixtures)', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses Google results when the markup matches the parser regexes', async () => {
    const html = `
      <h3 class="DKV84">Result Title</h3>
      <cite>https://example.com/page</cite>
      <span class="aXCZ0b">The result snippet text</span>
    `;
    globalThis.fetch = mockFetch(() => html) as unknown as typeof globalThis.fetch;
    const result = await searchTool.execute(
      { query: 'q', source: 'google' },
      {} as any,
      makeOpts(),
    );
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.title).toBe('Result Title');
    expect(result.results[0]?.url).toBe('https://example.com/page');
    expect(result.results[0]?.snippet).toBe('The result snippet text');
  });

  it('parses Bing results when the markup matches the parser regexes', async () => {
    const html = `
      <h2><a href="https://example.com/b">Bing Title</a></h2>
      <p class="b_paractl">Bing snippet text</p>
    `;
    globalThis.fetch = mockFetch(() => html) as unknown as typeof globalThis.fetch;
    const result = await searchTool.execute({ query: 'q', source: 'bing' }, {} as any, makeOpts());
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.title).toBe('Bing Title');
    expect(result.results[0]?.url).toBe('https://example.com/b');
  });

  it('returns empty results when Google fetch fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('net down');
    }) as unknown as typeof globalThis.fetch;
    const result = await searchTool.execute({ query: 'q', source: 'google' }, {} as any, makeOpts());
    expect(result.source).toBe('google');
    expect(result.results).toEqual([]);
  });

  it('returns empty results when Bing fetch fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('net down');
    }) as unknown as typeof globalThis.fetch;
    const result = await searchTool.execute({ query: 'q', source: 'bing' }, {} as any, makeOpts());
    expect(result.source).toBe('bing');
    expect(result.results).toEqual([]);
  });
});

describe('fetchWithTimeout error path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls clearTimeout(timer) in the catch block when fetch throws', async () => {
    // Mock fetch to reject so the catch block in fetchWithTimeout is exercised.
    // This covers lines 272-275 (clearTimeout in catch path).
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Network error');
    }) as unknown as typeof globalThis.fetch;

    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', source: 'duckduckgo' }, ctx, makeOpts());
    // Should return fallback result from the catch block, not throw
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Search unavailable');
  });
});

describe('anySignal already-aborted', () => {
  it('calls controller.abort() immediately when a passed signal is already aborted', async () => {
    // When anySignal receives an already-aborted signal, it calls
    // controller.abort() right away (lines 281-283). This causes fetch to
    // reject immediately, exercising the catch block with clearTimeout.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Should not be called - already aborted');
    }) as unknown as typeof globalThis.fetch;

    const ac = new AbortController();
    ac.abort(); // abort BEFORE passing to execute

    const ctx = {} as any;
    const result = await searchTool.execute(
      { query: 'test', source: 'duckduckgo' },
      ctx,
      { signal: ac.signal },
    );
    // Should get fallback result, not throw, because anySignal immediately aborted
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Search unavailable');
  });
});
