import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { HybridCompactor } from '../../src/execution/compactor.js';
import type { Message } from '../../src/types/messages.js';

function fakeContext(messages: Message[]): Context {
  const ctx = { messages } as unknown as Context;
  // Minimal state shim — compactors route mutations through ctx.state since
  // L1-A, but we don't want each test to spin up the full Context.
  (ctx as unknown as { state: unknown }).state = {
    replaceMessages(next: Message[]) {
      messages.length = 0;
      messages.splice(0, 0, ...next);
    },
    appendMessage(m: Message) {
      messages.splice(messages.length, 0, m);
    },
  };
  return ctx;
}

describe('HybridCompactor', () => {
  it('elides large old tool_results outside preserve window', async () => {
    const big = 'x'.repeat(20_000);
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `query ${i}` });
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: {} }],
      });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }],
      });
    }
    const ctx = fakeContext(messages);
    const c = new HybridCompactor({ preserveK: 5, eliseThreshold: 1000 });
    const report = await c.compact(ctx);
    expect(report.reductions.some((r) => r.phase === 'elision')).toBe(true);
    expect(report.after).toBeLessThan(report.before);
  });

  it('aggressive mode collapses ancient turns', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `t${i} ${'x'.repeat(500)}` });
      messages.push({ role: 'assistant', content: 'ok' });
    }
    const ctx = fakeContext(messages);
    const c = new HybridCompactor({ preserveK: 3 });
    const before = messages.length;
    await c.compact(ctx, { aggressive: true });
    expect(ctx.messages.length).toBeLessThan(before);
  });

  it('preserves recent turns', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }
    const lastFew = messages.slice(-6);
    const ctx = fakeContext(messages);
    const c = new HybridCompactor({ preserveK: 3 });
    await c.compact(ctx, { aggressive: true });
    for (const m of lastFew) {
      expect(ctx.messages).toContainEqual(m);
    }
  });

  it('honors context-window policy from ctx.meta', async () => {
    const big = 'x'.repeat(5000);
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: big }] },
      { role: 'assistant', content: 'old done' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'recent', content: big }] },
    ];
    const ctx = fakeContext(messages);
    ctx.meta = {
      contextWindowPolicy: {
        id: 'frugal',
        name: 'Frugal',
        description: '',
        thresholds: { warn: 0.45, soft: 0.6, hard: 0.75 },
        aggressiveOn: 'warn',
        preserveK: 1,
        eliseThreshold: 500,
        targetLoad: 0.5,
      },
    };
    const c = new HybridCompactor({ preserveK: 20, eliseThreshold: 10000 });
    await c.compact(ctx);

    expect(JSON.stringify(ctx.messages[0])).toContain('[elided:');
    expect(JSON.stringify(ctx.messages[2])).toContain(big);
  });
});
