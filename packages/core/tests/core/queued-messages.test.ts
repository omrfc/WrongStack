/**
 * Unit tests for queue awareness (queued-messages.ts):
 * setQueuedMessagesSnapshot(), consumeQueuedMessagesUpdate(),
 * peekQueuedMessages(), buildQueuedMessagesBlock().
 */
import { describe, expect, it } from 'vitest';
import {
  buildQueuedMessagesBlock,
  consumeQueuedMessagesUpdate,
  peekQueuedMessages,
  setQueuedMessagesSnapshot,
} from '../../src/core/queued-messages.js';
import { Context } from '../../src/core/context.js';

function makeCtx(): Context {
  return new Context({
    systemPrompt: [],
    provider: null as never,
    session: { id: 'x', pendingToolUses: [], append: async () => {}, flush: async () => {} },
    signal: new AbortController().signal,
    tokenCounter: { account: () => {} } as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'test',
  });
}

describe('setQueuedMessagesSnapshot / peekQueuedMessages', () => {
  it('stores the snapshot and peeks without consuming', () => {
    const ctx = makeCtx();
    expect(peekQueuedMessages(ctx)).toEqual([]);
    setQueuedMessagesSnapshot(ctx, ['fix the tests', 'also bump the version']);
    expect(peekQueuedMessages(ctx)).toEqual(['fix the tests', 'also bump the version']);
    // Peek does not mark seen.
    expect(consumeQueuedMessagesUpdate(ctx)).toEqual(['fix the tests', 'also bump the version']);
  });

  it('drops blank entries and trims whitespace', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, ['  a  ', '   ', '', 'b']);
    expect(peekQueuedMessages(ctx)).toEqual(['a', 'b']);
  });

  it('keeps the head-most 20 entries (the head is delivered first)', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(
      ctx,
      Array.from({ length: 25 }, (_, i) => `msg-${i}`),
    );
    const items = peekQueuedMessages(ctx);
    expect(items).toHaveLength(20);
    expect(items[0]).toBe('msg-0');
    expect(items[19]).toBe('msg-19');
  });

  it('truncates long messages to a preview', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, ['x'.repeat(2000)]);
    const [preview] = peekQueuedMessages(ctx);
    expect(preview).toBeDefined();
    expect(preview!.length).toBe(500);
    expect(preview!.endsWith('…')).toBe(true);
  });

  it('an empty snapshot with nothing previously seen leaves no state behind', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, []);
    expect(peekQueuedMessages(ctx)).toEqual([]);
    expect(consumeQueuedMessagesUpdate(ctx)).toBeNull();
    expect(ctx.meta._queuedMessagesAwareness).toBeUndefined();
  });
});

describe('consumeQueuedMessagesUpdate', () => {
  it('returns null when nothing was ever queued', () => {
    expect(consumeQueuedMessagesUpdate(makeCtx())).toBeNull();
  });

  it('fires once per snapshot — same state is never injected twice', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, ['a']);
    expect(consumeQueuedMessagesUpdate(ctx)).toEqual(['a']);
    expect(consumeQueuedMessagesUpdate(ctx)).toBeNull();
  });

  it('re-setting an identical snapshot stays quiet', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, ['a', 'b']);
    expect(consumeQueuedMessagesUpdate(ctx)).toEqual(['a', 'b']);
    setQueuedMessagesSnapshot(ctx, ['a', 'b']);
    expect(consumeQueuedMessagesUpdate(ctx)).toBeNull();
  });

  it('fires again when a message is appended', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, ['a']);
    consumeQueuedMessagesUpdate(ctx);
    setQueuedMessagesSnapshot(ctx, ['a', 'b']);
    expect(consumeQueuedMessagesUpdate(ctx)).toEqual(['a', 'b']);
  });

  it('fires again when a message is deleted (shrunken list implies removal)', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, ['a', 'b']);
    consumeQueuedMessagesUpdate(ctx);
    setQueuedMessagesSnapshot(ctx, ['b']);
    expect(consumeQueuedMessagesUpdate(ctx)).toEqual(['b']);
  });

  it('acknowledges a queue-emptied transition silently and clears state', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, ['a']);
    consumeQueuedMessagesUpdate(ctx);
    setQueuedMessagesSnapshot(ctx, []);
    expect(consumeQueuedMessagesUpdate(ctx)).toBeNull();
    expect(ctx.meta._queuedMessagesAwareness).toBeUndefined();
    // A later enqueue starts fresh and fires again.
    setQueuedMessagesSnapshot(ctx, ['c']);
    expect(consumeQueuedMessagesUpdate(ctx)).toEqual(['c']);
  });

  it('an unseen snapshot that empties before the next iteration never reaches the model', () => {
    const ctx = makeCtx();
    setQueuedMessagesSnapshot(ctx, ['a']);
    setQueuedMessagesSnapshot(ctx, []); // user cleared before iteration boundary
    expect(consumeQueuedMessagesUpdate(ctx)).toBeNull();
  });
});

describe('buildQueuedMessagesBlock', () => {
  it('renders a marker, numbered messages, and the not-instructions framing', () => {
    const text = buildQueuedMessagesBlock(['one', 'two']);
    expect(text).toContain('[QUEUED MESSAGES');
    expect(text).toContain('1. one');
    expect(text).toContain('2. two');
    expect(text).toContain('do NOT answer or act');
    expect(text).toContain('delivered as its own turn');
    expect(text.trimEnd().endsWith(']')).toBe(true);
  });
});
