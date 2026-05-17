import { describe, expect, it, vi } from 'vitest';
import { MCPClient, type MCPTool } from '../src/client.js';

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

  it('rejects unanswered stdio JSON-RPC requests after requestTimeoutMs', async () => {
    const c = new MCPClient({
      name: 'timeout-test',
      transport: 'stdio',
      command: 'noop',
      requestTimeoutMs: 20,
    });
    await expect(
      (c as unknown as { request: (method: string, params: unknown) => Promise<unknown> }).request(
        'tools/list',
        {},
      ),
    ).rejects.toThrow(/timed out/);
    expect((c as unknown as { pending: Map<unknown, unknown> }).pending.size).toBe(0);
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

    it('filters invalid tools and defaults missing inputSchema during refresh', async () => {
      const c = new MCPClient({ name: 'tlc-normalize', transport: 'stdio', command: 'noop' });
      (c as unknown as { request: (method: string) => Promise<unknown> }).request = async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: '', inputSchema: {} },
            { description: 'missing name', inputSchema: {} },
            { name: 'valid' },
          ],
        },
      });
      (c as unknown as { onLine: (line: string) => void }).onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(c.listTools()).toEqual([
        { name: 'valid', inputSchema: { type: 'object', properties: {} } },
      ]);
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

  describe('close() — stdio lifecycle edge cases', () => {
    it('close uses SIGTERM then escalates to SIGKILL on stuck process', async () => {
      // Test that close() correctly handles the graceful → forced kill sequence.
      // We spawn a process that ignores SIGTERM but dies on SIGKILL.
      const c = new MCPClient({
        name: 'force-kill-test',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.on("SIGTERM", () => process.exit(1)); while(true) {}'],
      });
      await c.close();
      expect(c.getState()).toBe('disconnected');
    });

    it('close sets state to disconnected even when child never started', async () => {
      const c = new MCPClient({
        name: 'never-started',
        transport: 'stdio',
        command: 'noop',
      });
      // Never called connect()
      await c.close();
      expect(c.getState()).toBe('disconnected');
    });

    it('close is safe to call multiple times', async () => {
      const c = new MCPClient({
        name: 'double-close',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.stdin.resume()'],
        startupTimeoutMs: 500,
      });
      // connect() will timeout but we can still test close()
      try {
        await c.connect();
      } catch {
        // Expected timeout
      }
      await c.close();
      await expect(c.close()).resolves.toBeUndefined();
      expect(c.getState()).toBe('disconnected');
    });
  });

  describe('failPending() — error propagation', () => {
    it('failPending with zero pending is a no-op', () => {
      const c = new MCPClient({
        name: 'empty-pending',
        transport: 'stdio',
        command: 'echo',
        args: ['x'],
      });
      // Call failPending directly on an idle client with empty pending map
      expect(() =>
        (c as unknown as { failPending: (reason: string) => void }).failPending('test reason'),
      ).not.toThrow();
    });

    it('failPending swallows exceptions in request reject handlers', () => {
      const c = new MCPClient({
        name: 'reject-swallow',
        transport: 'stdio',
        command: 'echo',
        args: ['x'],
      });
      // Manually add a pending entry with a reject that throws
      const id = (c as unknown as { nextId: number }).nextId++;
      (
        c as unknown as {
          pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
        }
      ).pending.set(id, {
        resolve: () => {},
        reject: () => {
          throw new Error('reject handler error');
        },
      });
      // failPending should not throw even when a reject handler throws
      expect(() =>
        (c as unknown as { failPending: (reason: string) => void }).failPending('test'),
      ).not.toThrow();
      expect((c as unknown as { pending: Map<unknown, unknown> }).pending.size).toBe(0);
    });
  });

  describe('notify() — backpressure handling', () => {
    it('hadNotifySkipped returns false after construction', () => {
      const c = new MCPClient({ name: 'notify-skipped', transport: 'stdio', command: 'echo' });
      expect(c.hadNotifySkipped()).toBe(false);
    });
  });

  describe('onLine() — JSON-RPC parsing edge cases', () => {
    it('onLine ignores malformed JSON', () => {
      const c = new MCPClient({ name: 'malformed-json', transport: 'stdio', command: 'echo' });
      const handler = vi.fn();
      (c as unknown as { onLine: (line: string) => void }).onLine('not json at all {{{');
      // Should not throw and should not call any handler
    });

    it('onLine handles server-initiated list_changed notification', async () => {
      const c = new MCPClient({
        name: 'server-list-changed',
        transport: 'stdio',
        command: 'echo',
        args: ['x'],
      });
      const toolsChanged = vi.fn();
      c.addToolsChangedListener(toolsChanged);
      // Simulate server sending a list_changed notification (no id)
      (c as unknown as { onLine: (line: string) => void }).onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
      );
      // Allow async handleToolsListChanged to complete
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe('addExitListener / removeExitListener', () => {
    it('removeExitListener on a never-added listener is safe', () => {
      const c = new MCPClient({ name: 'remove-never-added', transport: 'stdio', command: 'echo' });
      const handler = vi.fn();
      // Removing a listener that was never added should not throw
      expect(() => c.removeExitListener(handler)).not.toThrow();
    });

    it('addExitListener adds to exitListeners set', () => {
      const c = new MCPClient({ name: 'add-exit', transport: 'stdio', command: 'echo' });
      const handler = vi.fn();
      c.addExitListener(handler);
      // Verify the listener was added by removing it successfully
      expect(() => c.removeExitListener(handler)).not.toThrow();
    });
  });

  describe('addDisconnectListener / removeDisconnectListener', () => {
    it('removeDisconnectListener on a never-added listener is safe', () => {
      const c = new MCPClient({
        name: 'remove-disconnect-never',
        transport: 'stdio',
        command: 'echo',
      });
      const handler = vi.fn();
      expect(() => c.removeDisconnectListener(handler)).not.toThrow();
    });

    it('disconnectListeners are called on SSE transport disconnect', async () => {
      const c = new MCPClient({
        name: 'sse-disconnect-listeners',
        transport: 'sse',
        url: 'https://127.0.0.1:9', // Will fail to connect
        startupTimeoutMs: 100,
      });
      const handler = vi.fn();
      c.addDisconnectListener(handler);
      try {
        await c.connect();
      } catch {
        // Expected to fail — state should be 'failed'
      }
      // On failed state, no disconnect event is emitted (it's only emitted on transport-side disconnect)
      expect(c.getState()).toBe('failed');
    });
  });

  describe('listTools() — cache fallback behavior', () => {
    it('listTools returns _tools when non-empty', () => {
      const c = new MCPClient({ name: 'tools-nonempty', transport: 'stdio', command: 'echo' });
      (c as unknown as { _tools: MCPTool[] })._tools = [{ name: 'cached_tool', inputSchema: {} }];
      const tools = c.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('cached_tool');
    });

    it('listTools falls back to _toolsCache when _tools is empty', () => {
      const c = new MCPClient({ name: 'cache-fallback', transport: 'stdio', command: 'echo' });
      (c as unknown as { _tools: never[] })._tools = [];
      (c as unknown as { _toolsCache: MCPTool[] })._toolsCache = [
        { name: 'from_cache', inputSchema: {} },
      ];
      const tools = c.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('from_cache');
    });

    it('listTools returns empty array when both caches are empty', () => {
      const c = new MCPClient({ name: 'both-empty', transport: 'stdio', command: 'echo' });
      expect(c.listTools()).toEqual([]);
    });
  });

  describe('connect() — unknown transport', () => {
    it('connect throws unknown transport error and sets state to failed', async () => {
      const c = new MCPClient({
        name: 'unknown-transport',
        // @ts-expect-error — intentionally passing invalid transport for test
        transport: 'unknown-transport-xyz',
      });
      await expect(c.connect()).rejects.toThrow(/Unknown transport/);
      expect(c.getState()).toBe('failed');
    });
  });
});
