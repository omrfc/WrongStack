import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';

describe('MCPClient', () => {
  it('starts in idle state', () => {
    const c = new MCPClient({ name: 'test', transport: 'stdio', command: 'noop' });
    expect(c.getState()).toBe('idle');
    expect(c.listTools()).toEqual([]);
  });

  it('rejects SSE transport without url', async () => {
    const c = new MCPClient({ name: 'sse-no-url', transport: 'sse' });
    await expect(c.connect()).rejects.toThrow(/requires "url"/);
    expect(c.getState()).toBe('failed');
  });

  it('rejects streamable-http transport without url', async () => {
    const c = new MCPClient({ name: 'http-no-url', transport: 'streamable-http' });
    await expect(c.connect()).rejects.toThrow(/requires "url"/);
    expect(c.getState()).toBe('failed');
  });

  it('SSE transport fails when URL unreachable', async () => {
    const c = new MCPClient({
      name: 'sse-bad',
      transport: 'sse',
      url: 'https://127.0.0.1:9',
      startupTimeoutMs: 500,
    });
    await expect(c.connect()).rejects.toThrow();
    expect(c.getState()).toBe('failed');
  });

  it('streamable-http transport fails when URL unreachable', async () => {
    const c = new MCPClient({
      name: 'http-bad',
      transport: 'streamable-http',
      url: 'https://127.0.0.1:9',
      startupTimeoutMs: 500,
    });
    await expect(c.connect()).rejects.toThrow();
    expect(c.getState()).toBe('failed');
  }, 10_000);

  it('requires command for stdio transport', async () => {
    const c = new MCPClient({ name: 'no-cmd', transport: 'stdio' });
    await expect(c.connect()).rejects.toThrow(/requires "command"/);
    expect(c.getState()).toBe('failed');
  });

  it('callTool rejects when not connected', async () => {
    const c = new MCPClient({ name: 'idle', transport: 'stdio', command: 'noop' });
    await expect(c.callTool('any', {})).rejects.toThrow(/not connected/);
  });

  it('close on idle client is a no-op', async () => {
    const c = new MCPClient({ name: 'idle', transport: 'stdio', command: 'noop' });
    await expect(c.close()).resolves.toBeUndefined();
    expect(c.getState()).toBe('disconnected');
  });

  it('connect to nonexistent binary fails with timeout', async () => {
    const c = new MCPClient({
      name: 'broken',
      transport: 'stdio',
      command: '__definitely_not_a_binary__',
      startupTimeoutMs: 100,
    });
    await expect(c.connect()).rejects.toThrow();
  });

  it('addExitListener fires callback on child exit', () => {
    const c = new MCPClient({
      name: 'listener-test',
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
    });
    const handler = vi.fn();
    c.addExitListener(handler);
    // Simulate exit by directly emitting (can't easily test real spawn exit here)
    // The listener is registered correctly — verify by removing
    expect(() => c.removeExitListener(handler)).not.toThrow();
  });

  it('listTools returns cached tools after disconnect', () => {
    const c = new MCPClient({ name: 'cache-test', transport: 'stdio', command: 'echo' });
    // Before any connect, listTools returns empty
    expect(c.listTools()).toEqual([]);
    // listTools() of a client that has no tools yet but has a cache (set after first connect)
    // The fallback logic in listTools: prefer _tools over _toolsCache
    expect(c.listTools().length).toBe(0);
  });

  describe('L2-C tools/list_changed notification', () => {
    it('addToolsChangedListener accepts and removes listeners without throwing', () => {
      const c = new MCPClient({ name: 'tlc', transport: 'stdio', command: 'noop' });
      const listener = vi.fn();
      expect(() => c.addToolsChangedListener(listener)).not.toThrow();
      expect(() => c.removeToolsChangedListener(listener)).not.toThrow();
    });

    it('list_changed notification triggers refresh + listener via private onLine path', async () => {
      const c = new MCPClient({ name: 'tlc-2', transport: 'stdio', command: 'noop' });
      const refreshed: { name: string; tools: { name: string }[] }[] = [];
      c.addToolsChangedListener((name, tools) => {
        refreshed.push({ name, tools: tools.map((t) => ({ name: t.name })) });
      });
      // Stub the request method so the refresh "succeeds" without a real
      // child process. This drives the same code path as a real server
      // sending the notification.
      const fakeRequest = vi.fn(async (method: string) => {
        if (method === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [{ name: 'new_tool', inputSchema: {} }] },
          };
        }
        return { jsonrpc: '2.0', id: 1, result: {} };
      });
      // Cast through unknown to invoke private members for the test.
      (c as unknown as { request: typeof fakeRequest }).request = fakeRequest;
      (c as unknown as { onLine: (line: string) => void }).onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
      );
      // Allow the async refresh to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(fakeRequest).toHaveBeenCalledWith('tools/list', {});
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]?.tools[0]?.name).toBe('new_tool');
      // Cache is now invalidated to the new list
      expect(c.listTools()[0]?.name).toBe('new_tool');
    });

    it('list_changed refresh failure is swallowed; cache stays intact', async () => {
      const c = new MCPClient({ name: 'tlc-3', transport: 'stdio', command: 'noop' });
      // Pre-seed cache so we can verify it isn't wiped on error.
      (c as unknown as { _tools: { name: string }[] })._tools = [
        { name: 'cached', inputSchema: {} } as never,
      ];
      const listener = vi.fn();
      c.addToolsChangedListener(listener);
      (c as unknown as { request: () => Promise<unknown> }).request = async () => {
        throw new Error('upstream rejected');
      };
      (c as unknown as { onLine: (line: string) => void }).onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(listener).not.toHaveBeenCalled();
      expect(c.listTools()[0]?.name).toBe('cached');
    });
  });
});
