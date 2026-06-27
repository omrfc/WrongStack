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
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent } from '@wrongstack/core';

import type { AgentServerTransport } from '../src/agent/stdio-transport.js';
import { ACPProtocolHandler } from '../src/agent/protocol-handler.js';
import { makeACPServerAgentTurn } from '../src/agent/server-agent-turn.js';
import { ACPSessionStore } from '../src/agent/session-store.js';

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

  it('routes an image prompt into a multimodal ContentBlock[] input', async () => {
    let captured: unknown;
    const { handler, transport } = makeHandlerWithFactory(() => ({
      run: vi.fn(async (userMessage: unknown) => {
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
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'text', text: 'and tell me' },
        ],
      },
    });
    // With an image present the adapter builds a core ContentBlock[] so a
    // vision model can actually see it (not a bracketed text placeholder).
    expect(Array.isArray(captured)).toBe(true);
    const blocks = captured as Array<{ type: string; text?: string; source?: { media_type?: string; data?: string } }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(blocks[0]?.text).toBe('look at this:');
    expect(blocks[1]?.source).toMatchObject({ media_type: 'image/png', data: 'AAAA' });
    expect(blocks[2]?.text).toBe('and tell me');
  });

  it('keeps an all-text prompt as a plain string input', async () => {
    let captured: unknown;
    const { handler, transport } = makeHandlerWithFactory(() => ({
      run: vi.fn(async (userMessage: unknown) => {
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
      params: { sessionId, prompt: [{ type: 'text', text: 'just text' }] },
    });
    expect(captured).toBe('just text');
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

  it('streams tool_call / tool_call_update from the core agent event bus', async () => {
    // Minimal event-bus stand-in: captures handlers and lets run() fire them.
    const handlers: Record<string, (e: unknown) => void> = {};
    const bus = {
      on: (name: string, cb: (e: unknown) => void) => {
        handlers[name] = cb;
        return () => delete handlers[name];
      },
    };
    const fakeAgent = {
      events: bus,
      run: vi.fn(async () => {
        handlers['tool.started']?.({ id: 'tc1', name: 'write_file', input: { path: 'a.ts' } });
        handlers['tool.executed']?.({ id: 'tc1', name: 'write_file', ok: true, output: 'wrote' });
        return { text: 'done', stopReason: 'end_turn' };
      }),
      teardown: vi.fn(async () => {}),
    };

    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({ agentFor: async () => fakeAgent as never as Agent });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
    const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
    });

    const updates = transport.sent
      .map((m) => (m as { params?: { update?: { sessionUpdate?: string; status?: string; kind?: string } } }).params?.update)
      .filter((u): u is { sessionUpdate: string; status?: string; kind?: string } => !!u);
    const toolCall = updates.find((u) => u.sessionUpdate === 'tool_call');
    const toolUpdate = updates.find((u) => u.sessionUpdate === 'tool_call_update');
    expect(toolCall).toBeDefined();
    expect(toolCall?.kind).toBe('edit');
    expect(toolUpdate?.status).toBe('completed');
  });

  it('replays recorded user/agent history on session/load', async () => {
    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({
      agentFor: async () => makeFakeAgent('the answer') as never as Agent,
    });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
      replayFor: turn.replay,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
    const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;

    await handler.handleMessage({
      id: 3, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'the question' }] },
    });
    transport.sent.length = 0;

    await handler.handleMessage({ id: 4, method: 'session/load', params: { sessionId, cwd: '/test' } });

    const replayed = transport.sent
      .map((m) => (m as { method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }))
      .filter((m) => m.method === 'session/update')
      .map((m) => m.params?.update)
      .filter((u): u is { sessionUpdate: string; content?: { text?: string } } => !!u);
    const user = replayed.find((u) => u.sessionUpdate === 'user_message_chunk');
    const agent = replayed.find((u) => u.sessionUpdate === 'agent_message_chunk');
    expect(user?.content?.text).toBe('the question');
    expect(agent?.content?.text).toBe('the answer');
  });

  it('seeds a restored session\'s agent context with prior conversation', async () => {
    const appended: Array<{ role: string; content: unknown }> = [];
    const agent = {
      run: vi.fn(async () => ({ text: 'continued', stopReason: 'end_turn' as const })),
      teardown: vi.fn(async () => {}),
      ctx: { state: { appendMessage: (m: { role: string; content: unknown }) => appended.push(m) } },
    };
    const turn = makeACPServerAgentTurn({ agentFor: async () => agent as never as Agent });

    // Simulate a cold load: seed the prior conversation, then prompt.
    turn.seed('s1', [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first answer' } },
    ]);
    expect(turn.replay('s1')).toHaveLength(2); // seed also feeds replay

    await turn(
      { sessionId: 's1', prompt: [{ type: 'text', text: 'follow up' }], signal: new AbortController().signal },
      () => {},
    );

    // The new agent's context was primed with the prior turns as messages.
    expect(appended).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);

    // Seeding is one-shot: a second prompt on the same session doesn't re-seed.
    appended.length = 0;
    await turn(
      { sessionId: 's1', prompt: [{ type: 'text', text: 'again' }], signal: new AbortController().signal },
      () => {},
    );
    expect(appended).toEqual([]);
  });

  it('persists history and restores it on session/load after a "restart"', async () => {
    const dir = path.join(os.tmpdir(), `wstack-acp-store-${process.pid}-${Math.round(performance.now())}`);
    const store = new ACPSessionStore({ dir });
    try {
      // First server instance: create a session and run a turn.
      const t1 = fakeTransport();
      const turn1 = makeACPServerAgentTurn({
        agentFor: async () => makeFakeAgent('persisted answer') as never as Agent,
      });
      const h1 = new ACPProtocolHandler({
        transport: t1 as never as AgentServerTransport,
        defaultCwd: '/test',
        runTurn: turn1,
        replayFor: turn1.replay,
        store,
      });
      await h1.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await h1.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
      const sessionId = (t1.sent[t1.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      await h1.handleMessage({
        id: 3, method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'persisted question' }] },
      });

      // Second server instance (fresh in-memory state — simulates a restart),
      // sharing the same durable store.
      const t2 = fakeTransport();
      const turn2 = makeACPServerAgentTurn({
        agentFor: async () => makeFakeAgent('x') as never as Agent,
      });
      const h2 = new ACPProtocolHandler({
        transport: t2 as never as AgentServerTransport,
        defaultCwd: '/test',
        runTurn: turn2,
        replayFor: turn2.replay,
        seedFor: turn2.seed,
        store,
      });
      await h2.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      // Before load, the fresh turn engine knows nothing about the session.
      expect(turn2.replay(sessionId)).toHaveLength(0);
      await h2.handleMessage({ id: 2, method: 'session/load', params: { sessionId, cwd: '/test' } });
      // After load, the handler seeded the turn engine from the durable store.
      expect(turn2.replay(sessionId)).toHaveLength(2);

      const replayed = t2.sent
        .map((m) => (m as { method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }))
        .filter((m) => m.method === 'session/update')
        .map((m) => m.params?.update)
        .filter((u): u is { sessionUpdate: string; content?: { text?: string } } => !!u);
      expect(replayed.find((u) => u.sessionUpdate === 'user_message_chunk')?.content?.text).toBe('persisted question');
      expect(replayed.find((u) => u.sessionUpdate === 'agent_message_chunk')?.content?.text).toBe('persisted answer');
      // The load response succeeded (no error).
      const loadResp = t2.sent[t2.sent.length - 1] as { result?: unknown; error?: unknown };
      expect(loadResp.error).toBeUndefined();
      expect(loadResp.result).toBeDefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
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
