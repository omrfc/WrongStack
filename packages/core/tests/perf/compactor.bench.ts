import { bench, describe } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { HybridCompactor } from '../../src/execution/compactor.js';
import { IntelligentCompactor } from '../../src/execution/intelligent-compactor.js';
import type { Message } from '../../src/types/messages.js';

/**
 * V0-B: compaction runs whenever the context window approaches its limit.
 * For a long-running agent session, this is the single most expensive
 * piece of non-LLM work. We bench the compactor on a representative
 * 1000-message conversation and a worst-case 5000-message one.
 */

function buildMessages(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `user message ${i} ${'lorem ipsum '.repeat(50)}` });
    out.push({
      role: 'assistant',
      content: [{ type: 'text', text: `assistant reply ${i} ${'dolor sit '.repeat(80)}` }],
    });
  }
  return out;
}

function fakeContext(messages: Message[]): Context {
  const ctx = { messages } as unknown as Context;
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

const MEDIUM = buildMessages(500); // 1000 messages total (user + assistant)
const LARGE = buildMessages(2500); // 5000 messages total

describe('HybridCompactor', () => {
  bench('aggressive over 1000 messages', async () => {
    await new HybridCompactor({ preserveK: 5 }).compact(fakeContext([...MEDIUM]), {
      aggressive: true,
    });
  });
  bench('aggressive over 5000 messages', async () => {
    await new HybridCompactor({ preserveK: 5 }).compact(fakeContext([...LARGE]), {
      aggressive: true,
    });
  });
});

describe('IntelligentCompactor', () => {
  bench('aggressive over 1000 messages', async () => {
    await new IntelligentCompactor({ preserveK: 5 }).compact(fakeContext([...MEDIUM]), {
      aggressive: true,
    });
  });
});
