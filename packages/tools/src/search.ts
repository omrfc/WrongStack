import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { guardedFetch } from './fetch.js';

interface SearchInput {
  query: string;
  num_results?: number;
  source?: 'duckduckgo' | 'google' | 'bing';
}

interface SearchOutput {
  query: string;
  results: { title: string; url: string; snippet: string }[];
  source: string;
  truncated: boolean;
}

const DEFAULT_NUM = 10;
const MAX_RESULTS = 50;
const TIMEOUT_MS = 15_000;

export const searchTool: Tool<SearchInput, SearchOutput> = {
  name: 'search',
  category: 'Search',
  description: 'Search the web for information. Returns title, URL, and snippet for each result.',
  usageHint:
    'Set `num_results` (1-50, default 10). Use `source` to pick engine: duckduckgo (default), google, bing.',
  permission: 'confirm',
  mutating: false,
  timeoutMs: TIMEOUT_MS,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      num_results: {
        type: 'integer',
        description: 'Number of results (1-50, default 10)',
        minimum: 1,
        maximum: MAX_RESULTS,
      },
      source: {
        type: 'string',
        enum: ['duckduckgo', 'google', 'bing'],
        description: 'Search engine to use (default: duckduckgo)',
      },
    },
    required: ['query'],
  },
  async execute(input, ctx, opts) {
    let final: SearchOutput | undefined;
    for await (const ev of searchTool.executeStream!(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('search: stream ended without final event');
    return final;
  },
  async *executeStream(input, _ctx, opts): AsyncGenerator<ToolStreamEvent<SearchOutput>> {
    if (!input?.query) throw new Error('search: query is required');

    const num = Math.max(1, Math.min(input.num_results ?? DEFAULT_NUM, MAX_RESULTS));
    const source = input.source ?? 'duckduckgo';

    yield {
      type: 'log',
      text: `Querying ${source} for "${input.query}"…`,
      data: { source, query: input.query },
    };

    let output: SearchOutput;
    switch (source) {
      case 'duckduckgo':
        output = await duckduckgoSearch(input.query, num, opts.signal);
        break;
      case 'google':
        output = await googleSearch(input.query, num, opts.signal);
        break;
      case 'bing':
        output = await bingSearch(input.query, num, opts.signal);
        break;
      default:
        throw new Error(`search: unknown source "${source}"`);
    }

    yield {
      type: 'partial_output',
      text: `${output.results.length} results from ${output.source}`,
      data: { count: output.results.length },
    };
    yield { type: 'final', output };
  },
};

async function duckduckgoSearch(
  query: string,
  num: number,
  signal: AbortSignal,
): Promise<SearchOutput> {
  const encoded = encodeURIComponent(query);
  const url = `https://lite.duckduckgo.com/lite/?q=${encoded}&kd=-1&kl=wt-wt`;

  const results = await fetchWithTimeout(url, signal, TIMEOUT_MS)
    .then((r) => r.text())
    .then((html) => parseDuckDuckGo(html, num))
    .catch(() => [{ title: 'Search unavailable', url: '', snippet: 'Could not reach DuckDuckGo' }]);

  return {
    query,
    results,
    source: 'duckduckgo',
    truncated: results.length >= num,
  };
}

function takeFrom<T>(iter: Iterable<T>, max: number): T[] {
  const out: T[] = [];
  for (const item of iter) {
    if (out.length >= max) break;
    out.push(item);
  }
  return out;
}

function parseDuckDuckGo(html: string, num: number): SearchOutput['results'] {
  const results: SearchOutput['results'] = [];
  const snippetRegex = /<a class="result-link"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  const snippet2Regex = /<a class="result-snippet"[^>]*>([^<]+)<\/a>/gi;

  const linkMatches = takeFrom(
    [...html.matchAll(snippetRegex)]
      .filter((m) => m[1] && m[2])
      .map((m) => ({ url: m[1]!, title: stripTags(m[2]!) })),
    num,
  );

  const snippetMatches = takeFrom(
    [...html.matchAll(snippet2Regex)].filter((m) => m[1]).map((m) => stripTags(m[1]!)),
    num,
  );

  for (let i = 0; i < linkMatches.length && i < num; i++) {
    const entry = linkMatches[i];
    results.push({
      title: entry?.title ?? '',
      url: entry?.url ?? '',
      snippet: snippetMatches[i] ?? '',
    });
  }

  return results;
}

async function googleSearch(
  query: string,
  num: number,
  signal: AbortSignal,
): Promise<SearchOutput> {
  const encoded = encodeURIComponent(query);
  const url = `https://www.google.com/search?q=${encoded}&hl=en`;

  const html = await fetchWithTimeout(url, signal, TIMEOUT_MS)
    .then((r) => r.text())
    .catch(() => '');

  const results = parseGoogleResults(html, num);

  return {
    query,
    results,
    source: 'google',
    truncated: results.length >= num,
  };
}

function parseGoogleResults(html: string, num: number): SearchOutput['results'] {
  const results: SearchOutput['results'] = [];
  const titleRegex = /<h3[^>]*class="[^"]*DKV84"[^>]*>([^<]+)<\/h3>/gi;
  const urlRegex = /<cite[^>]*>([^<]+)<\/cite>/gi;
  const snippetRegex = /<span[^>]*class="[^"]*aXCZ0b[^>]*>([^<]+)<\/span>/gi;

  const titles = takeFrom(
    [...html.matchAll(titleRegex)].filter((m) => m[1]).map((m) => stripTags(m[1]!)),
    num,
  );

  const urls = takeFrom(
    [...html.matchAll(urlRegex)]
      .filter((m) => m[1])
      .map((m) => stripTags(m[1]!).replace(/^\*(https?:\/\/[^\s]+).*$/, '$1'))
      .filter((u) => u.startsWith('http')),
    num,
  );

  const snippets = takeFrom(
    [...html.matchAll(snippetRegex)].filter((m) => m[1]).map((m) => stripTags(m[1]!)),
    num,
  );

  for (let i = 0; i < Math.min(titles.length, num); i++) {
    results.push({
      title: titles[i] ?? '',
      url: urls[i] ?? '',
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

async function bingSearch(query: string, num: number, signal: AbortSignal): Promise<SearchOutput> {
  const encoded = encodeURIComponent(query);
  const url = `https://www.bing.com/search?q=${encoded}`;

  const html = await fetchWithTimeout(url, signal, TIMEOUT_MS)
    .then((r) => r.text())
    .catch(() => '');

  const results = parseBingResults(html, num);

  return {
    query,
    results,
    source: 'bing',
    truncated: results.length >= num,
  };
}

function parseBingResults(html: string, num: number): SearchOutput['results'] {
  const results: SearchOutput['results'] = [];
  const titleRegex = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<\/h2>/gi;
  const snippetRegex = /<p[^>]*class="[^"]*b_paractl[^"]*"[^>]*>([^<]+)<\/p>/gi;

  const entries = takeFrom(
    [...html.matchAll(titleRegex)]
      .filter((m) => m[1] && m[2])
      .map((m) => ({ url: m[1]!, title: stripTags(m[2]!) })),
    num,
  );

  const snippets = takeFrom(
    [...html.matchAll(snippetRegex)].filter((m) => m[1]).map((m) => stripTags(m[1]!)),
    num,
  );

  for (let i = 0; i < entries.length; i++) {
    results.push({
      title: entries[i]?.title ?? '',
      url: entries[i]?.url ?? '',
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

async function fetchWithTimeout(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fetchSignal = anySignal(signal, controller.signal);
  try {
    // F-05: route through the SSRF-guarded fetch (private-IP blocking, HTTPS,
    // DNS-pinned dispatcher, per-hop redirect re-validation) instead of a bare
    // `fetch` with `redirect: 'follow'`. Search hosts are fixed/trusted, but
    // this closes the residual "engine 30x → internal address" redirect risk.
    const res = await guardedFetch(url, 5, fetchSignal, {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', () => controller.abort());
  }
  return controller.signal;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
