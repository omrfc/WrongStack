import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  MCPServer,
  type MCPServerToolHost,
  serveHttp,
  serveStdio,
  toContentBlocks,
} from '../src/server.js';

function makeHost(overrides: Partial<MCPServerToolHost> = {}): MCPServerToolHost {
  return {
    listTools: () => [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }],
    callTool: async (name, args) => ({
      content: `${name}:${JSON.stringify(args)}`,
      isError: false,
    }),
    ...overrides,
  };
}

async function call(server: MCPServer, msg: unknown): Promise<Record<string, unknown> | null> {
  const res = await server.handleMessage(JSON.stringify(msg));
  return res === null ? null : (JSON.parse(res) as Record<string, unknown>);
}

describe('MCPServer.handleMessage', () => {
  it('responds to initialize with protocol version and serverInfo', async () => {
    const server = new MCPServer({ host: makeHost(), serverInfo: { name: 'ws', version: '9' } });
    const res = await call(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res?.id).toBe(1);
    const result = res?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({ name: 'ws', version: '9' });
    expect((result.capabilities as { tools?: unknown }).tools).toBeDefined();
  });

  it('lists tools', async () => {
    const server = new MCPServer({ host: makeHost() });
    const res = await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res?.result as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe('echo');
  });

  it('calls a tool and wraps the result as content blocks', async () => {
    const server = new MCPServer({ host: makeHost() });
    const res = await call(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { x: 1 } },
    });
    const result = res?.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo:{"x":1}' });
  });

  it('reports tool errors as isError without throwing the connection', async () => {
    const host = makeHost({
      callTool: async () => ({ content: 'boom', isError: true }),
    });
    const server = new MCPServer({ host });
    const res = await call(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'echo', arguments: {} },
    });
    const result = res?.result as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('returns INTERNAL_ERROR when the host throws', async () => {
    const host = makeHost({
      callTool: async () => {
        throw new Error('kaboom');
      },
    });
    const server = new MCPServer({ host, logger: { warn: vi.fn() } });
    const res = await call(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'echo' },
    });
    expect((res?.error as { code: number }).code).toBe(-32603);
  });

  it('returns METHOD_NOT_FOUND for unknown methods', async () => {
    const server = new MCPServer({ host: makeHost() });
    const res = await call(server, { jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
    expect((res?.error as { code: number }).code).toBe(-32601);
  });

  it('returns a parse error for malformed JSON', async () => {
    const server = new MCPServer({ host: makeHost() });
    const out = await server.handleMessage('{ not json');
    const res = JSON.parse(out!) as Record<string, unknown>;
    expect((res.error as { code: number }).code).toBe(-32700);
    expect(res.id).toBeNull();
  });

  it('does not respond to notifications (no id)', async () => {
    const server = new MCPServer({ host: makeHost() });
    expect(await call(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await server.handleMessage('   ')).toBeNull();
  });

  it('answers ping', async () => {
    const server = new MCPServer({ host: makeHost() });
    const res = await call(server, { jsonrpc: '2.0', id: 7, method: 'ping' });
    expect(res?.result).toEqual({});
  });
});

describe('toContentBlocks', () => {
  it('wraps a string', () => {
    expect(toContentBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });
  it('passes through pre-shaped text blocks', () => {
    const blocks = [{ type: 'text', text: 'a' }];
    expect(toContentBlocks(blocks)).toBe(blocks);
  });
  it('stringifies objects', () => {
    expect(toContentBlocks({ a: 1 })).toEqual([{ type: 'text', text: '{"a":1}' }]);
  });
  it('handles null/undefined', () => {
    expect(toContentBlocks(undefined)).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('serveStdio', () => {
  it('reads newline-delimited requests and writes responses', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new MCPServer({ host: makeHost() });
    const handle = serveStdio(server, { stdin, stdout });

    const lines: string[] = [];
    stdout.on('data', (c: Buffer) => {
      for (const l of c.toString('utf8').split('\n')) if (l.trim()) lines.push(l);
    });

    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    // notification — should produce no output
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);

    await vi.waitFor(() => expect(lines.length).toBe(2));
    handle.close();
    await handle.done;

    const ids = lines.map((l) => (JSON.parse(l) as { id: number }).id).sort();
    expect(ids).toEqual([1, 2]);
  });

  it('resolves done on stdin end', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = serveStdio(new MCPServer({ host: makeHost() }), { stdin, stdout });
    stdin.end();
    await expect(handle.done).resolves.toBeUndefined();
  });
});

describe('serveHttp', () => {
  it('serves JSON-RPC over POST on an ephemeral loopback port', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const r = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { result: { tools: unknown[] } };
      expect(body.result.tools).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('answers a GET health probe', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const r = await fetch(handle.url);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { status: string }).status).toBe('ok');
    } finally {
      await handle.close();
    }
  });

  it('returns 202 (no body) for notifications', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const r = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(r.status).toBe(202);
    } finally {
      await handle.close();
    }
  });

  it('enforces bearer token when configured', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), {
      port: 0,
      token: 'secret',
    });
    try {
      const unauth = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(unauth.status).toBe(401);
      const ok = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(ok.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('refuses to bind a non-loopback host without a token', async () => {
    await expect(
      serveHttp(new MCPServer({ host: makeHost() }), { host: '0.0.0.0' }),
    ).rejects.toThrow(/non-loopback/);
  });
});
