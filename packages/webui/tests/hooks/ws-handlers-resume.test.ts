import { beforeEach, describe, expect, it, vi } from 'vitest';

// ws-handlers reaches for the live socket (files.tree refetch, mailbox
// re-query) — stub it so handlers run without a server.
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send: vi.fn() }),
}));

import { WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { useChatStore } from '../../src/stores/chat-store';
import { useSessionStore } from '../../src/stores/session-store';
import { useUIStore } from '../../src/stores/ui-store';

function fireSessionStart(payload: Record<string, unknown>) {
  WS_HANDLERS['session.start']?.({ type: 'session.start', payload });
}

const BASE_PAYLOAD = {
  sessionId: 'sess_resumed',
  model: 'test-model',
  provider: 'test-provider',
  maxContext: 200_000,
  inputCost: 3,
  outputCost: 15,
  cacheReadCost: 0.3,
};

describe('session.start resume transition', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
    useChatStore.getState().setLoading(false);
    useSessionStore.setState({ session: null, todos: [] });
    useUIStore.getState().setCurrentView('chat');
  });

  it('switches to the chat view when a resume replay arrives', () => {
    useUIStore.getState().setCurrentView('sessions');
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [{ role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' }],
    });
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('does not yank the view on a plain session.start (connect/new)', () => {
    useUIStore.getState().setCurrentView('sessions');
    fireSessionStart({ ...BASE_PAYLOAD, reset: true });
    expect(useUIStore.getState().currentView).toBe('sessions');
  });

  it('hydrates replayed messages into the chat store', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        { role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' },
        { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      ],
    });
    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('hello');
    expect(messages[0]?.timestamp).toBe(Date.parse('2026-06-11T10:00:00Z'));
    expect(messages[1]?.content).toBe('world');
  });

  it('attaches replayed tool_result blocks to tool_use messages by id', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'toolu_2', name: 'grep', input: { pattern: 'x' } },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents', is_error: false },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'no matches' }], is_error: true },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    });

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
    expect(messages[1]).toMatchObject({
      toolUseId: 'toolu_1',
      toolName: 'read',
      toolResult: 'file contents',
      isError: false,
    });
    expect(messages[2]).toMatchObject({
      toolUseId: 'toolu_2',
      toolName: 'grep',
      toolResult: JSON.stringify([{ type: 'text', text: 'no matches' }]),
      isError: true,
    });
  });

  it('hydrates replayed messages with one bulk chat-store update', () => {
    const addSpy = vi.spyOn(useChatStore.getState(), 'addMessage');
    const setToolResultSpy = vi.spyOn(useChatStore.getState(), 'setToolResult');
    const setMessagesSpy = vi.spyOn(useChatStore.getState(), 'setMessages');

    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
    });

    expect(addSpy).not.toHaveBeenCalled();
    expect(setToolResultSpy).not.toHaveBeenCalled();
    expect(setMessagesSpy).toHaveBeenCalledTimes(1);
  });

  it('restores lifetime usage and recomputes cost from the payload rates', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [],
      replayUsage: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
    });
    const s = useSessionStore.getState();
    expect(s.totalTokens.input).toBe(1_000_000);
    expect(s.totalTokens.output).toBe(100_000);
    // (1M × $3/M) + (100k × $15/M) = $4.50
    expect(s.cost).toBeCloseTo(4.5, 5);
  });

  it('clears the stale streaming flag and plan on reset', () => {
    useChatStore.getState().setLoading(true);
    useSessionStore.setState({
      todos: [{ id: 't1', content: 'old todo', status: 'pending' }],
    });
    fireSessionStart({ ...BASE_PAYLOAD, reset: true });
    expect(useChatStore.getState().isLoading).toBe(false);
    expect(useSessionStore.getState().todos).toHaveLength(0);
  });
});
