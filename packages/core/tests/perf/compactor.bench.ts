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

/** Forces the elision full-pass by including oversized tool_result blocks. */
function buildMessagesWithOversizedToolResults(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `user message ${i}` });
    out.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `tu_${i}`,
          name: 'bash',
          input: { command: `echo ${i}` },
        },
      ],
    });
    // Each tool_result block must exceed the eliseThreshold (2000 tokens ≈ 7000 chars).
    // RoughTokenEstimate divides by 3.5, so 7000 chars ≈ 2000 tokens.
    out.push({
      role: 'tool',
      tool_call_id: `tu_${i}`,
      content: [
        {
          type: 'tool_result',
          content: `output ${i} ${'x'.repeat(7000)}`, // ≈ 2001 tokens > 2000 threshold
        },
      ],
    });
  }
  return out;
}

// Use 2000 exchanges so preserve window (≈10 messages) is tiny relative to total.
// Oversized tool results in the first 1990 exchanges are all OUTSIDE the preserve
// window, forcing the full pass to run.
const WITH_OVERSIZED_TOOL_RESULTS = buildMessagesWithOversizedToolResults(2000);

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
  bench('full-pass elision with oversized tool_results', async () => {
    // Every tool_result exceeds eliseThreshold → full pass must run
    await new HybridCompactor({ preserveK: 5 }).compact(
      fakeContext([...WITH_OVERSIZED_TOOL_RESULTS]),
      { aggressive: true },
    );
  });
});

describe('IntelligentCompactor', () => {
  bench('aggressive over 1000 messages', async () => {
    await new IntelligentCompactor({ preserveK: 5 }).compact(fakeContext([...MEDIUM]), {
      aggressive: true,
    });
  });
});
