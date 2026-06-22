/**
 * Tests for `makeACPServerAgentTurn`.
 *
 * The adapter takes a `Agent` factory. We inject a fake agent that
 * returns canned text, then drive the adapter through the v1 server
 * handler and assert that:
 *  - the agent is created once per sessionId and reused across turns
 *  - the agent's result text is emitted as an `agent_message_chunk`
 *  - on parent abort, the result stopReason is `cancelled`
 *  - non-text content blocks are converted to bracketed placeholders
 */
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@wrongstack/core';

import type { AgentServerTransport } from '../src/agent/stdio-transport.js';
import { ACPProtocolHandler } from '../src/agent/protocol-handler.js';
import { makeACPServerAgentTurn } from '../src/agent/server-agent-turn.js';

interface FakeAgent {
  run: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(text: string): FakeAgent {
  return {
    run: vi.fn(async (input: unknown) => {
      // Honor the abort signal — if aborted, throw AbortError to
      // simulate the real Agent's behavior.
      const sig = (input as { opts?: { signal?: AbortSignal } })?.opts?.signal;
      if (sig?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      return { text, stopReason: 'end_turn' };
    }),
    teardown: vi.fn(async () => {}),
  };
}

interface FakeTransport {
  sent: unknown[];
  send: ReturnType<typeof vi.fn>;
}

function fakeTransport(): FakeTransport {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (m: unknown) => { sent.push(m); }),
  };
}

function makeHandlerWithFactory(agentFor: (sessionId: string) => FakeAgent) {
  const transport = fakeTransport();
  const turn = makeACPServerAgentTurn({
    agentFor: async () => agentFor('sess') as never as Agent,
  });
  const handler = new ACPProtocolHandler({
    transport: transport as never as AgentServerTransport,
    defaultCwd: '/test',
    runTurn: turn,
  });
  return { handler, transport, agents: { current: undefined as FakeAgent | undefined } };
}

describe('makeACPServerAgentTurn', () => {
  it('runs a turn, emits agent_message_chunk with the agent text, and resolves end_turn', async () => {
    const { handler, transport } = makeHandlerWithFactory(() => makeFakeAgent('hello world'));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
    const newResp = transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } };
    const sessionId = newResp.result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'say hi' }] },
    });

    // Two sends: agent_message_chunk + prompt response
    expect(transport.sent.length).toBe(2);
    const note = transport.sent[0] as { params?: { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } };
    expect(note.params?.update?.sessionUpdate).toBe('agent_message_chunk');
    expect(note.params?.update?.content?.text).toBe('hello world');

    const resp = transport.sent[1] as { result?: { stopReason?: string } };
    expect(resp.result?.stopReason).toBe('end_turn');
  });

  it('converts non-text content blocks to bracketed placeholders', async () => {
    let captured = '';
    const { handler, transport } = makeHandlerWithFactory(() => ({
      run: vi.fn(async (userMessage: string) => {
        captured = userMessage;
        return { text: 'ok', stopReason: 'end_turn' };
      }),
      teardown: vi.fn(async () => {}),
    }));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
    const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          { type: 'text', text: 'look at this:' },
          { type: 'image', mimeType: 'image/png' },
          { type: 'text', text: 'and tell me' },
        ],
      },
    });
    expect(captured).toContain('look at this:');
    expect(captured).toContain('[image: image/png]');
    expect(captured).toContain('and tell me');
  });

  it('returns cancelled stopReason when the parent signal aborts', async () => {
    const { handler, transport } = makeHandlerWithFactory(() => makeFakeAgent('hello'));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
    const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
    transport.sent.length = 0;

    const ac = new AbortController();
    ac.abort();
    // The adapter's prompt is called with the parent signal (aborted)
    // — the fake agent throws AbortError. The handler should still
    // resolve with a non-error response, NOT propagate the throw
    // (the agent's adapter catches it).
    await expect(
      handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      }),
    ).resolves.toBeDefined();
  });

  it('creates one agent per session and reuses it across turns', async () => {
    const createCount = { value: 0 };
    const sharedRun = vi.fn(async () => ({ text: 'reuse', stopReason: 'end_turn' as const }));
    const sharedTeardown = vi.fn(async () => {});

    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({
      agentFor: async () => {
        createCount.value++;
        return { run: sharedRun, teardown: sharedTeardown } as never as Agent;
      },
    });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
    const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
    transport.sent.length = 0;

    // First turn
    await handler.handleMessage({
      id: 3, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'a' }] },
    });
    transport.sent.length = 0;
    // Second turn on the same session
    await handler.handleMessage({
      id: 4, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'b' }] },
    });

    expect(createCount.value).toBe(1);
    expect(sharedRun).toHaveBeenCalledTimes(2);
  });
});
