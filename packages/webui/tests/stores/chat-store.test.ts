import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../../src/stores/chat-store';
import type { ChatMessage } from '../../src/stores/types.js';

// ── crypto mock ───────────────────────────────────────────────────────
// Must be set before the store module loads (vi.mock is hoisted).
let uuidCounter = 0;
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: () => `uuid-${String(uuidCounter++).padStart(4, '0')}`,
  };
});

// ── helpers ──────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<ChatMessage> = {}): Omit<ChatMessage, 'id' | 'timestamp'> {
  return {
    content: 'hello',
    role: 'user',
    ...overrides,
  };
}

function addMsg(overrides: Partial<ChatMessage> = {}): string {
  return useChatStore.getState().addMessage(makeMsg(overrides));
}

beforeEach(() => {
  uuidCounter = 0;
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  // Reset to initial state.
  useChatStore.setState({
    messages: [],
    currentAssistantMessageId: null,
    currentToolId: null,
    isLoading: false,
    abortController: null,
    executions: new Map(),
    queue: [],
    runStart: null,
    thinkingBuffer: '',
    thinkingStartedAt: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── dedupeRepeatedBlocks ──────────────────────────────────────────────

describe('dedupeRepeatedBlocks (finalizeMessage)', () => {
  it('returns empty string unchanged', () => {
    addMsg({ role: 'assistant', content: '' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('');
  });

  it('keeps a single paragraph', () => {
    addMsg({ role: 'assistant', content: 'unique content' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('unique content');
  });

  it('removes consecutive duplicate paragraphs', () => {
    addMsg({ role: 'assistant', content: 'intro\n\nsame\n\nsame\n\noutro' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('intro\n\nsame\n\noutro');
  });

  it('removes consecutive duplicate lines within a paragraph', () => {
    addMsg({ role: 'assistant', content: 'line\nline\nother' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('line\nother');
  });

  it('preserves non-consecutive duplicates', () => {
    // 'a' appears in paragraphs 1 and 3 — separated by 'b', so both survive.
    addMsg({ role: 'assistant', content: 'a\n\nb\n\na' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('a\n\nb\n\na');
  });

  it('sets streaming to false', () => {
    addMsg({ role: 'assistant', content: 'hello', streaming: true });
    const id = useChatStore.getState().messages[0].id;
    useChatStore.getState().finalizeMessage(id);
    expect(useChatStore.getState().messages[0].streaming).toBe(false);
  });
});

// ── addMessage ────────────────────────────────────────────────────────

describe('addMessage', () => {
  it('returns a message id', () => {
    const id = addMsg();
    expect(typeof id).toBe('string');
  });

  it('adds the message to the messages array', () => {
    addMsg();
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it('uses provided timestamp when given', () => {
    addMsg({ timestamp: 999 });
    expect(useChatStore.getState().messages[0].timestamp).toBe(999);
  });

  it('uses Date.now() when no timestamp given', () => {
    addMsg();
    expect(useChatStore.getState().messages[0].timestamp).toBe(1_700_000_000_000);
  });

  it('sets currentAssistantMessageId when role is assistant', () => {
    addMsg({ role: 'assistant' });
    const id = useChatStore.getState().messages[0].id;
    expect(useChatStore.getState().currentAssistantMessageId).toBe(id);
  });

  it('does not change currentAssistantMessageId for user role', () => {
    const initial = useChatStore.getState().currentAssistantMessageId;
    addMsg({ role: 'user' });
    expect(useChatStore.getState().currentAssistantMessageId).toBe(initial);
  });

  it('does not change currentAssistantMessageId for tool role', () => {
    addMsg({ role: 'assistant' });
    const firstId = useChatStore.getState().currentAssistantMessageId;
    addMsg({ role: 'tool' });
    expect(useChatStore.getState().currentAssistantMessageId).toBe(firstId);
  });

  it('carries through extra fields', () => {
    addMsg({ role: 'assistant', toolName: 'Bash', toolInput: { command: 'ls' } });
    const msg = useChatStore.getState().messages[0];
    expect(msg.toolName).toBe('Bash');
    expect((msg as ChatMessage).toolInput).toEqual({ command: 'ls' });
  });
});

// ── setMessages ───────────────────────────────────────────────────────

describe('setMessages', () => {
  it('replaces messages in one store update and clears active stream/tool state', () => {
    const assistantId = addMsg({ role: 'assistant', content: 'streaming', streaming: true });
    const toolId = addMsg({ role: 'tool', content: '', toolUseId: 'toolu_1' });
    useChatStore.setState({ currentAssistantMessageId: assistantId, currentToolId: toolId });

    useChatStore.getState().setMessages([
      { id: 'replay_0', role: 'user', content: 'resumed', timestamp: 123 },
    ]);

    const state = useChatStore.getState();
    expect(state.messages).toEqual([{ id: 'replay_0', role: 'user', content: 'resumed', timestamp: 123 }]);
    expect(state.currentAssistantMessageId).toBeNull();
    expect(state.currentToolId).toBeNull();
    expect(state.executions.size).toBe(0);
  });
});

// ── updateMessage ─────────────────────────────────────────────────────

describe('updateMessage', () => {
  it('updates a message field', () => {
    const id = addMsg({ content: 'original' });
    useChatStore.getState().updateMessage(id, { content: 'updated' });
    expect(useChatStore.getState().messages[0].content).toBe('updated');
  });

  it('merges multiple fields', () => {
    const id = addMsg({ content: 'orig' });
    useChatStore.getState().updateMessage(id, { content: 'new', isError: true });
    expect(useChatStore.getState().messages[0].content).toBe('new');
    expect(useChatStore.getState().messages[0].isError).toBe(true);
  });

  it('does not affect other messages', () => {
    const id1 = addMsg({ content: 'msg1' });
    addMsg({ content: 'msg2' });
    useChatStore.getState().updateMessage(id1, { content: 'changed' });
    expect(useChatStore.getState().messages[1].content).toBe('msg2');
  });

  it('ignores unknown id', () => {
    addMsg();
    expect(() => useChatStore.getState().updateMessage('not-found', { content: 'x' })).not.toThrow();
  });

  it('does not modify other messages when updating one', () => {
    const id1 = addMsg({ content: 'msg1' });
    addMsg({ content: 'msg2' });
    useChatStore.getState().updateMessage(id1, { content: 'changed' });
    expect(useChatStore.getState().messages[1].content).toBe('msg2');
  });
});

// ── appendToMessage ───────────────────────────────────────────────────

describe('appendToMessage', () => {
  it('appends text to existing message', () => {
    const id = addMsg({ content: 'hello' });
    useChatStore.getState().appendToMessage(id, ' world');
    expect(useChatStore.getState().messages[0].content).toBe('hello world');
  });

  it('accumulates multiple appends', () => {
    const id = addMsg({ content: 'a' });
    useChatStore.getState().appendToMessage(id, 'b');
    useChatStore.getState().appendToMessage(id, 'c');
    expect(useChatStore.getState().messages[0].content).toBe('abc');
  });

  it('ignores unknown id without throwing', () => {
    expect(() => useChatStore.getState().appendToMessage('not-found', 'x')).not.toThrow();
  });
});

// ── finalizeMessage ───────────────────────────────────────────────────

describe('finalizeMessage', () => {
  it('sets streaming to false', () => {
    const id = addMsg({ role: 'assistant', content: 'hi', streaming: true });
    useChatStore.getState().finalizeMessage(id);
    expect(useChatStore.getState().messages[0].streaming).toBe(false);
  });

  it('runs dedupe on content', () => {
    // Duplicate paragraphs get collapsed.
    const id = addMsg({ role: 'assistant', content: 'intro\n\nintro\n\noutro' });
    useChatStore.getState().finalizeMessage(id);
    expect(useChatStore.getState().messages[0].content).toBe('intro\n\noutro');
  });

  it('ignores unknown id', () => {
    expect(() => useChatStore.getState().finalizeMessage('not-found')).not.toThrow();
  });
});

// ── setToolResult ─────────────────────────────────────────────────────

describe('setToolResult', () => {
  it('sets toolResult and isError on the message', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().setToolResult(id, 'result data', true);
    expect(useChatStore.getState().messages[0].toolResult).toBe('result data');
    expect(useChatStore.getState().messages[0].isError).toBe(false);
  });

  it('sets isError true when ok is false', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().setToolResult(id, 'error msg', false);
    expect(useChatStore.getState().messages[0].isError).toBe(true);
  });

  it('clears progressLines', () => {
    const id = addMsg({ role: 'tool', progressLines: ['line1', 'line2'] });
    useChatStore.getState().setToolResult(id, 'done', true);
    expect(useChatStore.getState().messages[0].progressLines).toBeUndefined();
  });

  it('ignores unknown id', () => {
    expect(() => useChatStore.getState().setToolResult('not-found', 'x', true)).not.toThrow();
  });
});

// ── appendToolProgressLines ───────────────────────────────────────────

describe('appendToolProgressLines', () => {
  it('adds lines to progressLines', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().appendToolProgressLines(id, ['building...', 'done']);
    expect(useChatStore.getState().messages[0].progressLines).toEqual(['building...', 'done']);
  });

  it('appends to existing progressLines', () => {
    const id = addMsg({ role: 'tool', progressLines: ['step1'] });
    useChatStore.getState().appendToolProgressLines(id, ['step2']);
    expect(useChatStore.getState().messages[0].progressLines).toEqual(['step1', 'step2']);
  });

  it('caps progressLines at 30 lines', () => {
    const id = addMsg({ role: 'tool' });
    const lines = Array.from({ length: 35 }, (_, i) => `line${i}`);
    useChatStore.getState().appendToolProgressLines(id, lines);
    const kept = useChatStore.getState().messages[0].progressLines!;
    expect(kept).toHaveLength(30);
    expect(kept[0]).toBe('line5'); // last 30 = indices 5..34
  });

  it('ignores empty array', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().appendToolProgressLines(id, []);
    expect(useChatStore.getState().messages[0].progressLines).toBeUndefined();
  });

  it('ignores unknown message id', () => {
    expect(() => useChatStore.getState().appendToolProgressLines('not-found', ['x'])).not.toThrow();
  });
});

// ── appendToolProgress (delegates to appendToolProgressLines) ─────────

describe('appendToolProgress', () => {
  it('appends a single line', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().appendToolProgress(id, 'single line');
    expect(useChatStore.getState().messages[0].progressLines).toEqual(['single line']);
  });
});

// ── setLoading ────────────────────────────────────────────────────────

describe('setLoading', () => {
  it('sets isLoading to true', () => {
    useChatStore.getState().setLoading(true);
    expect(useChatStore.getState().isLoading).toBe(true);
  });

  it('sets isLoading to false', () => {
    useChatStore.getState().setLoading(true);
    useChatStore.getState().setLoading(false);
    expect(useChatStore.getState().isLoading).toBe(false);
  });
});

// ── setAbortController ────────────────────────────────────────────────

describe('setAbortController', () => {
  it('sets the abort controller', () => {
    const ctrl = new AbortController();
    useChatStore.getState().setAbortController(ctrl);
    expect(useChatStore.getState().abortController).toBe(ctrl);
  });

  it('can be set to null', () => {
    const ctrl = new AbortController();
    useChatStore.getState().setAbortController(ctrl);
    useChatStore.getState().setAbortController(null);
    expect(useChatStore.getState().abortController).toBeNull();
  });
});

// ── clearMessages ─────────────────────────────────────────────────────

describe('clearMessages', () => {
  it('clears all messages', () => {
    addMsg();
    addMsg();
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('resets currentAssistantMessageId to null', () => {
    addMsg({ role: 'assistant' });
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().currentAssistantMessageId).toBeNull();
  });

  it('resets currentToolId to null', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentToolId(id);
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().currentToolId).toBeNull();
  });

  it('clears the executions map', () => {
    useChatStore.getState().addExecution({ id: 'exec1', name: 'test', ok: true, startedAt: 0 });
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().executions.size).toBe(0);
  });
});

// ── setCurrentAssistantMessage ────────────────────────────────────────

describe('setCurrentAssistantMessage', () => {
  it('sets currentAssistantMessageId', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentAssistantMessage(id);
    expect(useChatStore.getState().currentAssistantMessageId).toBe(id);
  });

  it('can be set to null', () => {
    addMsg();
    useChatStore.getState().setCurrentAssistantMessage(null);
    expect(useChatStore.getState().currentAssistantMessageId).toBeNull();
  });
});

// ── setCurrentToolId ─────────────────────────────────────────────────

describe('setCurrentToolId', () => {
  it('sets currentToolId', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentToolId(id);
    expect(useChatStore.getState().currentToolId).toBe(id);
  });

  it('can be set to null', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentToolId(id);
    useChatStore.getState().setCurrentToolId(null);
    expect(useChatStore.getState().currentToolId).toBeNull();
  });
});

// ── truncateAfter ─────────────────────────────────────────────────────

describe('truncateAfter', () => {
  it('keeps messages up to and including the given id', () => {
    const id1 = addMsg({ content: 'msg1' });
    addMsg({ content: 'msg2' });
    addMsg({ content: 'msg3' });
    useChatStore.getState().truncateAfter(id1);
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['msg1']);
  });

  it('keeps all messages when truncating after the last message', () => {
    addMsg({ content: 'msg1' });
    addMsg({ content: 'msg2' });
    const id3 = addMsg({ content: 'msg3' });
    useChatStore.getState().truncateAfter(id3);
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('resets currentAssistantMessageId to null', () => {
    addMsg({ role: 'assistant' });
    const id2 = addMsg({ role: 'assistant', content: 'msg2' });
    useChatStore.getState().truncateAfter(id2);
    expect(useChatStore.getState().currentAssistantMessageId).toBeNull();
  });

  it('resets currentToolId to null', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentToolId(id);
    useChatStore.getState().truncateAfter(id);
    expect(useChatStore.getState().currentToolId).toBeNull();
  });

  it('returns state unchanged when id not found', () => {
    addMsg({ content: 'msg1' });
    useChatStore.getState().truncateAfter('not-found');
    expect(useChatStore.getState().messages).toHaveLength(1);
  });
});

// ── executions ────────────────────────────────────────────────────────

describe('addExecution', () => {
  it('adds an execution to the map', () => {
    const exec = { id: 'exec-1', name: 'Bash', ok: true, startedAt: 100 };
    useChatStore.getState().addExecution(exec);
    expect(useChatStore.getState().executions.get('exec-1')).toEqual(exec);
  });

  it('can add multiple executions', () => {
    useChatStore.getState().addExecution({ id: 'e1', name: 'x', ok: true, startedAt: 0 });
    useChatStore.getState().addExecution({ id: 'e2', name: 'y', ok: false, startedAt: 1 });
    expect(useChatStore.getState().executions.size).toBe(2);
  });
});

describe('updateExecution', () => {
  it('updates an existing execution', () => {
    useChatStore.getState().addExecution({ id: 'e1', name: 'Bash', ok: true, startedAt: 0 });
    useChatStore.getState().updateExecution('e1', { ok: false, completedAt: 50 });
    expect(useChatStore.getState().executions.get('e1')).toMatchObject({
      name: 'Bash',
      ok: false,
      completedAt: 50,
    });
  });

  it('ignores unknown execution id', () => {
    expect(() => useChatStore.getState().updateExecution('not-found', { ok: false })).not.toThrow();
  });
});

// ── queue ─────────────────────────────────────────────────────────────

describe('enqueue', () => {
  it('adds a message to the queue', () => {
    useChatStore.getState().enqueue('hello');
    expect(useChatStore.getState().queue).toContain('hello');
  });

  it('appends to existing queue', () => {
    useChatStore.getState().enqueue('a');
    useChatStore.getState().enqueue('b');
    expect(useChatStore.getState().queue).toEqual(['a', 'b']);
  });
});

describe('dequeue', () => {
  it('removes and returns the first item', () => {
    useChatStore.getState().enqueue('first');
    useChatStore.getState().enqueue('second');
    expect(useChatStore.getState().dequeue()).toBe('first');
    expect(useChatStore.getState().queue).toEqual(['second']);
  });

  it('returns null when queue is empty', () => {
    expect(useChatStore.getState().dequeue()).toBeNull();
  });
});

describe('removeQueued', () => {
  it('removes item at the given index', () => {
    useChatStore.getState().enqueue('a');
    useChatStore.getState().enqueue('b');
    useChatStore.getState().enqueue('c');
    useChatStore.getState().removeQueued(1);
    expect(useChatStore.getState().queue).toEqual(['a', 'c']);
  });
});

describe('clearQueue', () => {
  it('empties the queue', () => {
    useChatStore.getState().enqueue('a');
    useChatStore.getState().enqueue('b');
    useChatStore.getState().clearQueue();
    expect(useChatStore.getState().queue).toEqual([]);
  });
});

// ── runStart ─────────────────────────────────────────────────────────

describe('setRunStart', () => {
  it('sets runStart', () => {
    const val = { at: 1000, cost: 0.05 };
    useChatStore.getState().setRunStart(val);
    expect(useChatStore.getState().runStart).toEqual(val);
  });

  it('can be set to null', () => {
    useChatStore.getState().setRunStart({ at: 1, cost: 0 });
    useChatStore.getState().setRunStart(null);
    expect(useChatStore.getState().runStart).toBeNull();
  });
});

// ── thinkingBuffer ────────────────────────────────────────────────────

describe('appendThinking', () => {
  it('appends text to thinkingBuffer', () => {
    useChatStore.getState().appendThinking('thinking...');
    expect(useChatStore.getState().thinkingBuffer).toBe('thinking...');
  });

  it('accumulates across calls', () => {
    useChatStore.getState().appendThinking('part1');
    useChatStore.getState().appendThinking('part2');
    expect(useChatStore.getState().thinkingBuffer).toBe('part1part2');
  });

  it('sets thinkingStartedAt on first call', () => {
    expect(useChatStore.getState().thinkingStartedAt).toBeNull();
    useChatStore.getState().appendThinking('x');
    expect(useChatStore.getState().thinkingStartedAt).toBe(1_700_000_000_000);
  });

  it('does not reset thinkingStartedAt on subsequent calls', () => {
    useChatStore.getState().appendThinking('first');
    const firstAt = useChatStore.getState().thinkingStartedAt!;
    useChatStore.getState().appendThinking('second');
    expect(useChatStore.getState().thinkingStartedAt).toBe(firstAt);
  });
});

describe('clearThinking', () => {
  it('clears thinkingBuffer', () => {
    useChatStore.getState().appendThinking('thinking...');
    useChatStore.getState().clearThinking();
    expect(useChatStore.getState().thinkingBuffer).toBe('');
  });

  it('sets thinkingStartedAt to null', () => {
    useChatStore.getState().appendThinking('x');
    useChatStore.getState().clearThinking();
    expect(useChatStore.getState().thinkingStartedAt).toBeNull();
  });
});
