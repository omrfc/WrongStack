import { describe, expect, it, vi } from 'vitest';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';
import type { ACPToolsRegistry } from '../src/agent/tools-registry.js';
import { ACPProtocolHandler, WRONGSTACK_VERSION } from '../src/agent/protocol-handler.js';

function fakeTransport() {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn<(msg: unknown) => Promise<void>>().mockImplementation(async (msg: unknown) => {
      sent.push(msg);
    }),
  };
}

function fakeRegistry() {
  return {
    has: vi.fn<(s: string) => boolean>(),
    execute: vi.fn<(name: string, input: Record<string, unknown>, context: unknown, signal: AbortSignal) => Promise<unknown>>(),
    buildToolList: vi.fn<() => { tools: unknown[] }>().mockReturnValue({ tools: [] }),
  };
}

function fakeContext() {
  return { cwd: '/test', projectRoot: '/test' };
}

describe('ACPProtocolHandler', () => {
  describe('initialization', () => {
    it('initialize sets initialized=true and returns capabilities', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());

      const terminal = await handler.handleMessage({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11' },
      });

      expect(terminal).toBe(false);
      expect(transport.send).toHaveBeenCalledOnce();
      const response = transport.sent[0] as { result?: Record<string, unknown> };
      expect(response.result).toMatchObject({
        protocolVersion: '2024-11',
        agentVersion: WRONGSTACK_VERSION,
        agentName: 'WrongStack',
        capabilities: expect.arrayContaining(['code-generation', 'async-tools', 'streaming', 'progress']),
      });
    });

    it('initialize uses default protocol version when not provided', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());

      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      const response = transport.sent[0] as { result?: { protocolVersion: string } };
      expect(response.result?.protocolVersion).toBe('2024-11');
    });

    it('rejects non-initialize requests before initialization', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());

      await handler.handleMessage({ id: 1, method: 'tools/list' });

      const response = transport.sent[0] as { error?: { code: number; message: string } };
      expect(response.error?.code).toBe(-32000);
      expect(response.error?.message).toBe('Not initialized');
    });

    it('accepts initialize after a previous initialize (re-initialization)', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());

      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });
      await handler.handleMessage({ id: 2, method: 'initialize', params: {} });

      expect(transport.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('tools/call', () => {
    it('executes a known tool and returns its result', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      registry.has.mockReturnValue(true);
      registry.execute.mockResolvedValue({ content: [{ type: 'text', text: 'hello' }] });

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { msg: 'hi' } },
      });

      expect(registry.execute).toHaveBeenCalledWith('echo', { msg: 'hi' }, fakeContext(), expect.any(AbortSignal));
      const response = transport.sent[0] as { result?: { content: unknown[] } };
      expect(response.result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    });

    it('returns isError=true when tool throws', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      registry.has.mockReturnValue(true);
      registry.execute.mockRejectedValue(new Error('boom'));

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'tools/call',
        params: { name: 'flaky', arguments: {} },
      });

      const response = transport.sent[0] as { result?: { content: unknown[]; isError: boolean } };
      expect(response.result?.isError).toBe(true);
      expect(response.result?.content).toEqual([{ type: 'text', text: 'boom' }]);
    });

    it('stringifies a non-Error thrown by the tool', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      registry.has.mockReturnValue(true);
      registry.execute.mockRejectedValue('plain string failure');

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'tools/call', params: { name: 'odd', arguments: {} } });

      const response = transport.sent[0] as { result?: { content: { text: string }[]; isError: boolean } };
      expect(response.result?.isError).toBe(true);
      expect(response.result?.content[0]?.text).toBe('plain string failure');
    });

    it('returns isError=true for unknown tool', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      registry.has.mockReturnValue(false);

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'tools/call',
        params: { name: 'nonexistent', arguments: {} },
      });

      const response = transport.sent[0] as { result?: { content: unknown[]; isError: boolean } };
      expect(response.result?.isError).toBe(true);
      expect(response.result?.content).toEqual([{ type: 'text', text: 'Tool not found: nonexistent' }]);
      expect(registry.execute).not.toHaveBeenCalled();
    });

    it('returns null result as empty text', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      registry.has.mockReturnValue(true);
      registry.execute.mockResolvedValue(null);

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'tools/call',
        params: { name: 'void-tool', arguments: {} },
      });

      const response = transport.sent[0] as { result?: { content: unknown[]; isError: boolean } };
      expect(response.result?.content).toEqual([{ type: 'text', text: 'Tool returned null' }]);
      expect(response.result?.isError).toBe(false);
    });
  });

  describe('tools/list', () => {
    it('returns the tool list from the registry', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const fakeTools = { tools: [{ name: 'read', description: 'read file' }] };
      registry.buildToolList.mockReturnValue(fakeTools);

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'tools/list' });

      const response = transport.sent[0] as { result?: { tools: unknown[] } };
      expect(response.result).toEqual(fakeTools);
    });
  });

  describe('ping', () => {
    it('responds with pong:true', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'ping' });

      const response = transport.sent[0] as { result?: { pong: boolean } };
      expect(response.result).toEqual({ pong: true });
    });
  });

  describe('cancel', () => {
    it('deletes the pending call and responds ok:true', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      registry.has.mockReturnValue(true);
      // Never resolve so the call stays pending
      registry.execute.mockReturnValue(new Promise(() => {}));

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      // Start a long-running tool call
      handler.handleMessage({
        id: 2,
        method: 'tools/call',
        params: { name: 'sleep', arguments: {} },
      });

      // Give it a tick to register the pending call
      await new Promise((r) => setTimeout(r, 10));

      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'cancel' });

      const response = transport.sent[0] as { result?: { ok: boolean } };
      expect(response.result).toEqual({ ok: true });

      // Clean up the hanging tool call
      handler.handleMessage({ id: 99, method: 'cancel' }); // no-op after our cancel
    });

    it('returns ok:true even when no call is pending', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({ id: 99, method: 'cancel' });

      const response = transport.sent[0] as { result?: { ok: boolean } };
      expect(response.result).toEqual({ ok: true });
    });
  });

  describe('sessionInfoUpdate', () => {
    it('acknowledges with ok:true', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      const terminal = await handler.handleMessage({ id: 2, method: 'sessionInfoUpdate' });
      expect(terminal).toBe(false);
      const response = transport.sent[0] as { result?: { ok: boolean } };
      expect(response.result).toEqual({ ok: true });
    });
  });

  describe('session/list', () => {
    it('returns empty sessions array', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'session/list' });

      const response = transport.sent[0] as { result?: { sessions: unknown[] } };
      expect(response.result).toEqual({ sessions: [] });
    });
  });

  describe('unknown method', () => {
    it('returns error with code -32601', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'unknown/method' } as never);

      const response = transport.sent[0] as { error?: { code: number; message: string } };
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBe('Unknown method: unknown/method');
    });
  });

  describe('wireAbortController', () => {
    it('sends cancel for all pending calls when abort signal fires', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      registry.has.mockReturnValue(true);
      // Never resolve — keeps the call pending
      registry.execute.mockReturnValue(new Promise(() => {}));

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      // Start two pending tool calls
      handler.handleMessage({ id: 2, method: 'tools/call', params: { name: 'a', arguments: {} } });
      handler.handleMessage({ id: 3, method: 'tools/call', params: { name: 'b', arguments: {} } });

      await new Promise((r) => setTimeout(r, 10)); // let calls register

      transport.sent.length = 0;
      const abortController = new AbortController();
      handler.wireAbortController(abortController);
      abortController.abort();

      await new Promise((r) => setTimeout(r, 10)); // let send() calls process

      // Both pending calls should have received cancel messages
      const cancels = transport.sent.filter(
        (m) => (m as { method?: string }).method === 'cancel',
      );
      expect(cancels.length).toBeGreaterThanOrEqual(2);
    });

    it('does not throw when transport.send fails during abort', async () => {
      const transport = fakeTransport();
      // Reject only after initialize (track call count via mockImplementation)
      let callCount = 0;
      transport.send.mockImplementation(async () => {
        callCount++;
        if (callCount > 1) throw new Error('transport gone');
      });

      const registry = fakeRegistry();
      registry.has.mockReturnValue(true);
      registry.execute.mockReturnValue(new Promise(() => {}));

      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      handler.handleMessage({ id: 2, method: 'tools/call', params: { name: 'a', arguments: {} } });
      await new Promise((r) => setTimeout(r, 10));

      const abortController = new AbortController();
      handler.wireAbortController(abortController);

      // Should not throw — error is caught and logged at debug level
      expect(() => abortController.abort()).not.toThrow();
    });
  });

  describe('notifications (no id)', () => {
    it('handleCancelNotification does not throw for cancel notification', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      // cancel notifications have no id — they return false (non-terminal)
      const terminal = await handler.handleMessage({
        method: 'cancel',
        params: { reason: 'user-requested' },
      });
      expect(terminal).toBe(false);
    });

    it('any notification is non-terminal', async () => {
      const transport = fakeTransport();
      const registry = fakeRegistry();
      const handler = new ACPProtocolHandler(transport as unknown as AgentServerTransport, registry as unknown as ACPToolsRegistry, fakeContext());
      await handler.handleMessage({ id: 1, method: 'initialize', params: {} });

      // Reset call count so we only check calls from the notification itself
      transport.send.mockClear();
      transport.sent.length = 0;
      const terminal = await handler.handleMessage({ method: 'someNotification' } as never);
      expect(terminal).toBe(false);
      // No response sent for notifications
      expect(transport.send).not.toHaveBeenCalled();
    });
  });
});
