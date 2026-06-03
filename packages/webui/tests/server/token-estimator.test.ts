import { describe, expect, it } from 'vitest';
import {
  estimateContextBreakdown,
  estimateTokens,
  stringifyContent,
} from '../../src/server/token-estimator.js';

/**
 * The per-section token breakdown behind `context.debug`. Pure maths, so these
 * pin the 4-chars-per-token heuristic and the per-block accounting that used to
 * be an inline closure in `index.ts`.
 */

describe('estimateTokens', () => {
  it('rounds up at 4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });
});

describe('stringifyContent', () => {
  it('returns strings as-is and JSON-encodes objects', () => {
    expect(stringifyContent('hello')).toBe('hello');
    expect(stringifyContent({ a: 1 })).toBe('{"a":1}');
  });
  it('falls back to String() on non-serializable input (cycles)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(stringifyContent(cyclic)).toBe('[object Object]');
  });
});

describe('estimateContextBreakdown', () => {
  it('sums system prompt, tool schema, and message tokens', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [{ text: 'a'.repeat(40) }, { text: 'b'.repeat(8) }], // 10 + 2 = 12
      tools: [{ name: 'read', description: 'reads', inputSchema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'a'.repeat(20) }], // 5
    });

    expect(out.systemPrompt).toBe(12);
    // tool: estimate('read'=4 →1) + estimate('reads'=5 →2) + estimate('{"type":"object"}'=17 →5) = 8
    expect(out.tools.total).toBe(8);
    expect(out.tools.count).toBe(1);
    expect(out.tools.breakdown[0]).toEqual({ name: 'read', tokens: 8 });
    expect(out.messages.total).toBe(5);
    expect(out.total).toBe(12 + 8 + 5);
  });

  it('accounts for each block type in array message content', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [],
      tools: [],
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a'.repeat(40) }, // 10
            { type: 'tool_use', name: 'grep', input: { q: 'x' } }, // estimate('{"q":"x"}'=9 →3)
            { type: 'tool_result', content: 'a'.repeat(8) }, // 2
          ],
        },
      ],
    });
    expect(out.messages.breakdown[0]?.tokens).toBe(10 + 3 + 2);
    expect(out.messages.total).toBe(15);
    expect(out.total).toBe(15);
  });

  it('builds previews per block type and truncates to 60 chars', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [],
      tools: [],
      messages: [
        { role: 'user', content: 'x'.repeat(100) },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello world' },
            { type: 'tool_use', name: 'grep', input: { q: 'x' } },
            { type: 'tool_result', content: 'whatever' },
            { type: 'image' },
          ],
        },
      ],
    });
    expect(out.messages.breakdown[0]?.preview).toBe('x'.repeat(60));
    expect(out.messages.breakdown[1]?.preview).toBe(
      'hello world [tool_use: grep] [tool_result] [image]',
    );
  });

  it('handles empty input', () => {
    const out = estimateContextBreakdown({ systemPrompt: [], tools: [], messages: [] });
    expect(out).toEqual({
      total: 0,
      systemPrompt: 0,
      tools: { total: 0, count: 0, breakdown: [] },
      messages: { total: 0, count: 0, breakdown: [] },
    });
  });
});
