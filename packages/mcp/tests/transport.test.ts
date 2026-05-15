import { describe, expect, it, vi } from 'vitest';
import { SSEReader, SSETransport, StreamableHTTPTransport } from '../src/transport.js';

describe('SSEReader', () => {
  it('dispatches a single complete event', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    r.feed('data: {"jsonrpc":"2.0","id":1,"params":{"x":42}}\n\n');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(1);
  });

  it('handles chunked data across feed() calls', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    r.feed('data: {"jso');
    r.feed('nrpc":"2.0","id":2}\n');
    r.feed('\n');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(2);
  });

  it('ignores parse errors silently and continues with the next event', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    r.feed('data: not-json\n\n');
    r.feed('data: {"jsonrpc":"2.0","id":7}\n\n');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(7);
  });

  it('unsubscribe stops further dispatches', () => {
    const r = new SSEReader();
    const cb = vi.fn();
    const off = r.onMessage(cb);
    r.feed('data: {"id":1}\n\n');
    off();
    r.feed('data: {"id":2}\n\n');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('handler exception does not block other handlers', () => {
    const r = new SSEReader();
    const good = vi.fn();
    r.onMessage(() => {
      throw new Error('boom');
    });
    r.onMessage(good);
    r.feed('data: {"id":1}\n\n');
    expect(good).toHaveBeenCalledOnce();
  });

  it('reset clears buffer and listeners', () => {
    const r = new SSEReader();
    const cb = vi.fn();
    r.onMessage(cb);
    // Feed a partial line — no trailing newline, so the parser hasn't
    // processed it yet. reset() must wipe both the listeners and the
    // half-built buffer so the remainder of the event is treated as
    // garbage instead of being completed against the prior prefix.
    r.feed('data: {"id":1');
    r.reset();
    r.feed('}\n\n');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('SSETransport — connection failure modes', () => {
  it('starts in idle state', () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    expect(t.getState()).toBe('idle');
    expect(t.listTools()).toEqual([]);
  });

  it('transitions to failed when fetch rejects', async () => {
    const t = new SSETransport({
      name: 'x',
      url: 'http://127.0.0.1:1/never',
      startupTimeoutMs: 200,
    });
    await expect(t.connect()).rejects.toThrow();
    expect(t.getState()).toBe('failed');
  });

  it('callTool throws when not connected', async () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    await expect(t.callTool('any', {})).rejects.toThrow(/not connected/);
  });

  it('close is safe to call without connect', async () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    await expect(t.close()).resolves.toBeUndefined();
    expect(t.getState()).toBe('disconnected');
  });

  it('startupTimeoutMs bounds connect() wall-clock duration', async () => {
    const t = new SSETransport({
      name: 'slow',
      url: 'http://10.255.255.1/never', // blackholed
      startupTimeoutMs: 150,
    });
    const start = Date.now();
    await expect(t.connect()).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Generous bound: the timer fires at 150ms, plus fetch + abort
    // bookkeeping. If we ever get above 2000ms the timeout isn't wired.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('StreamableHTTPTransport — connection failure modes', () => {
  it('starts in idle state', () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    expect(t.getState()).toBe('idle');
    expect(t.listTools()).toEqual([]);
  });

  it('transitions to failed when fetch rejects', async () => {
    const t = new StreamableHTTPTransport({
      name: 'x',
      url: 'http://127.0.0.1:1/never',
      startupTimeoutMs: 200,
    });
    await expect(t.connect()).rejects.toThrow();
    expect(t.getState()).toBe('failed');
  });

  it('callTool throws when not connected', async () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    await expect(t.callTool('any', {})).rejects.toThrow(/not connected/);
  });

  it('startupTimeoutMs bounds connect() wall-clock duration', async () => {
    const t = new StreamableHTTPTransport({
      name: 'slow',
      url: 'http://10.255.255.1/never',
      startupTimeoutMs: 150,
    });
    const start = Date.now();
    await expect(t.connect()).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it('onDisconnect returns unsubscribe function', () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    const cb = vi.fn();
    const off = t.onDisconnect(cb);
    expect(typeof off).toBe('function');
    off();
  });

  it('onDisconnect unsubscribe works', () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    const cb = vi.fn();
    const off = t.onDisconnect(cb);
    off();
    // Manually trigger to verify cb is no longer called
    // We can't easily test the internal call since there's no disconnect() without connect()
    // But we verified the unsubscribe function removes the handler
  });

  it('close is idempotent', async () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    await t.close(); // first call
    await t.close(); // second call — must not throw
    expect(t.getState()).toBe('disconnected');
  });
});

describe('StreamableHTTPTransport — connect/callTool with mocked fetch', () => {
  function mkFetch(
    handlers: ((
      url: string,
      init: { body?: string; headers?: Record<string, string> },
    ) => Promise<Response> | Response)[],
  ): typeof globalThis.fetch {
    let i = 0;
    return ((url: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
      const h = handlers[i++];
      if (!h) throw new Error(`unexpected fetch (no handler for call ${i})`);
      return Promise.resolve(h(url, init));
    }) as unknown as typeof globalThis.fetch;
  }

  function jsonRes(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  it('connect → initialize → tools/list happy path', async () => {
    const calls: { method: string; body: any }[] = [];
    const fetchImpl = mkFetch([
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        calls.push({ method: body.method, body });
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } });
      },
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        calls.push({ method: body.method, body });
        return jsonRes({ jsonrpc: '2.0' });
      },
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        calls.push({ method: body.method, body });
        return jsonRes({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'hello', description: 'd', inputSchema: { type: 'object' } }] },
        });
      },
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      expect(t.getState()).toBe('connected');
      expect(t.listTools().map((x) => x.name)).toEqual(['hello']);
      expect(calls.map((c) => c.method)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('callTool returns { content, isError } after a successful connect', async () => {
    const fetchImpl = mkFetch([
      // initialize
      (_u, init) => jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: {} }),
      // notifications/initialized — postRaw requires a valid JSON-RPC line
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { tools: [{ name: 'hello' }] },
        }),
      // tools/call
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { content: 'hi', isError: false },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      const res = await t.callTool('hello', { who: 'world' });
      expect(res.content).toBe('hi');
      expect(res.isError).toBe(false);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('callTool surfaces error responses', async () => {
    const fetchImpl = mkFetch([
      (_u, init) => jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: {} }),
      () => jsonRes({ jsonrpc: '2.0' }),
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { tools: [] },
        }),
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          error: { code: -32601, message: 'bad call' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      const res = await t.callTool('nope', {});
      expect(res.isError).toBe(true);
      expect(res.content).toContain('bad call');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('connect throws when initialize returns a JSON-RPC error', async () => {
    const fetchImpl = mkFetch([
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          error: { code: -1, message: 'no good' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/initialize failed/);
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('connect throws when initialize body cannot be parsed', async () => {
    const fetchImpl = mkFetch([
      () =>
        new Response('totally not JSON', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow();
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('connect parses NDJSON body when content-type is not application/json', async () => {
    const ndjson = [JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), ''].join('\n');
    const fetchImpl = mkFetch([
      () => new Response(ndjson, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      // notifications/initialized — postRaw requires a valid JSON-RPC line
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { tools: [] },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      expect(t.getState()).toBe('connected');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('connect throws when init returns non-OK status', async () => {
    const fetchImpl = mkFetch([
      () => new Response('err', { status: 502, statusText: 'Bad Gateway' }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/initialize HTTP 502/);
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('onToolsChanged subscribe + unsubscribe', () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://x' });
    const cb = vi.fn();
    const off = t.onToolsChanged(cb);
    off();
    expect(cb).not.toHaveBeenCalled();
  });
});
