import { describe, expect, it, vi } from 'vitest';
import {
  Context,
  DefaultTokenCounter,
  HybridCompactor,
  IntelligentCompactor,
  type Message,
  type Provider,
  type SessionWriter,
  type StateChange,
  type TextBlock,
} from '../../src/index.js';

/**
 * L1-A regression: prove the reactive-state migration actually fires
 * onChange events for every state-mutating path. If a future commit
 * reintroduces a direct `ctx.messages.push(...)`, the subscriber sees
 * fewer changes than expected and this test fails.
 */

const fakeProvider = {} as Provider;
const fakeSession: SessionWriter = {
  id: 'sess-l1a',
  append: async () => undefined,
  close: async () => undefined,
};

function mkContext(): Context {
  return new Context({
    systemPrompt: [{ type: 'text', text: 'sys' } as TextBlock],
    provider: fakeProvider,
    session: fakeSession,
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    cwd: '/cwd',
    projectRoot: '/root',
    model: 'm',
  });
}

function bigMessages(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `user message ${i} ${'x'.repeat(500)}` });
    out.push({ role: 'assistant', content: `assistant reply ${i} ${'y'.repeat(500)}` });
  }
  return out;
}

describe('L1-A: ctx.state is the single source of reactive truth', () => {
  it('Context exposes a stable .state ConversationState wrapper', () => {
    const ctx = mkContext();
    expect(ctx.state).toBeDefined();
    // Accessing twice returns the same instance (lazy cache).
    expect(ctx.state).toBe(ctx.state);
    // Mutating through state is visible on ctx.messages.
    ctx.state.appendMessage({ role: 'user', content: 'hi' });
    expect(ctx.messages).toHaveLength(1);
  });

  it('appendMessage via ctx.state fires onChange', () => {
    const ctx = mkContext();
    const changes: StateChange[] = [];
    ctx.state.onChange((c) => changes.push(c));
    ctx.state.appendMessage({ role: 'user', content: 'one' });
    ctx.state.appendMessage({ role: 'assistant', content: 'two' });
    expect(changes).toHaveLength(2);
    expect(changes[0]!.kind).toBe('message_appended');
    expect(changes[1]!.kind).toBe('message_appended');
  });

  it('HybridCompactor.compact rewrites via replaceMessages (onChange fires once)', async () => {
    const ctx = mkContext();
    // Seed enough turns that the compactor decides to collapse.
    for (const m of bigMessages(40)) ctx.state.appendMessage(m);

    const baseline = [...ctx.messages];
    expect(baseline.length).toBeGreaterThan(20);

    const seen: StateChange[] = [];
    ctx.state.onChange((c) => seen.push(c));

    const compactor = new HybridCompactor({ preserveK: 3 });
    await compactor.compact(ctx, { aggressive: true });

    // The compactor must produce at least one messages_replaced change.
    expect(seen.some((c) => c.kind === 'messages_replaced')).toBe(true);
    // And the messages list actually shrank.
    expect(ctx.messages.length).toBeLessThan(baseline.length);
  });

  it('IntelligentCompactor.compact rewrites via replaceMessages', async () => {
    const ctx = mkContext();
    for (const m of bigMessages(40)) ctx.state.appendMessage(m);

    const seen: StateChange[] = [];
    ctx.state.onChange((c) => seen.push(c));

    const ic = new IntelligentCompactor({ preserveK: 3 });
    await ic.compact(ctx, { aggressive: true });

    expect(seen.some((c) => c.kind === 'messages_replaced')).toBe(true);
  });

  it('unsubscribe stops further callbacks', () => {
    const ctx = mkContext();
    const cb = vi.fn();
    const off = ctx.state.onChange(cb);
    ctx.state.appendMessage({ role: 'user', content: 'a' });
    off();
    ctx.state.appendMessage({ role: 'user', content: 'b' });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
