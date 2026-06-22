import { describe, expect, it, vi } from 'vitest';
import { ToolCapabilities } from '@wrongstack/core';
import type { MCPClient, MCPTool } from '../src/client.js';
import { wrapMCPTool } from '../src/wrap-tool.js';

const mkClient = (callImpl: (name: string, input: unknown) => Promise<unknown>) =>
  ({
    callTool: vi.fn(async (name: string, input: unknown) => {
      const out = await callImpl(name, input);
      return { content: out, isError: false };
    }),
  }) as never as MCPClient;

describe('wrapMCPTool', () => {
  it('namespaces tool names', () => {
    const mcpTool: MCPTool = { name: 'list', inputSchema: { type: 'object' } };
    const wrapped = wrapMCPTool(
      'postgres',
      mcpTool,
      mkClient(async () => 'ok'),
    );
    expect(wrapped.name).toBe('mcp__postgres__list');
  });

  it('declares the MCP proxy capability for permission boundaries', () => {
    const wrapped = wrapMCPTool(
      'ssh',
      { name: 'ssh_execute', inputSchema: { type: 'object' } },
      mkClient(async () => 'ok'),
    );
    expect(wrapped.capabilities).toContain(ToolCapabilities.MCP_PROXY);
  });

  it('marks mutating heuristically', () => {
    const wrapped = wrapMCPTool(
      'fs',
      { name: 'writeFile', inputSchema: { type: 'object' } },
      mkClient(async () => 'ok'),
    );
    expect(wrapped.mutating).toBe(true);
    const ro = wrapMCPTool(
      'fs',
      { name: 'listDirectory', inputSchema: { type: 'object' } },
      mkClient(async () => 'ok'),
    );
    expect(ro.mutating).toBe(false);
  });

  it('flattens content array of text blocks', async () => {
    const wrapped = wrapMCPTool(
      's',
      { name: 'fetch', inputSchema: { type: 'object' } },
      mkClient(async () => [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ]),
    );
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    const out = await wrapped.execute({}, ctx, { signal: new AbortController().signal });
    expect(out).toBe('line1\nline2');
  });

  it('stringifies non-text object content as JSON', async () => {
    const wrapped = wrapMCPTool(
      's',
      { name: 'fetch', inputSchema: { type: 'object' } },
      mkClient(async () => ({ foo: 1, bar: [1, 2] })),
    );
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    const out = await wrapped.execute({}, ctx, { signal: new AbortController().signal });
    expect(out).toContain('foo');
    expect(out).toContain('1');
  });

  it('stringifies null/undefined result as empty string', async () => {
    const wrapped = wrapMCPTool(
      's',
      { name: 'noop', inputSchema: { type: 'object' } },
      mkClient(async () => null),
    );
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    const out = await wrapped.execute({}, ctx, { signal: new AbortController().signal });
    expect(out).toBe('');
  });
});
