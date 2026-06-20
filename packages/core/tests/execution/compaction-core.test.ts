import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLosslessDigest,
  buildSmartDigest,
  eliseOldToolResults,
  extractText,
  findExchangeStart,
  findPreserveStart,
  findSafeBoundary,
  hasLargeToolResult,
  hasToolUse,
  scoreMessage,
} from '../../src/execution/compaction-core.js';
import type { Message } from '../../src/types/index.js';

afterEach(() => vi.restoreAllMocks());

const text = (role: Message['role'], t: string): Message => ({ role, content: [{ type: 'text', text: t }] }) as Message;
const strMsg = (role: Message['role'], t: string): Message => ({ role, content: t }) as Message;
const toolUse = (role: Message['role'] = 'assistant'): Message => ({ role, content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: {} }] }) as Message;
const toolResult = (content: unknown, role: Message['role'] = 'user'): Message => ({ role, content: [{ type: 'tool_result', tool_use_id: 'u1', content }] }) as Message;

describe('extractText / hasToolUse / hasLargeToolResult', () => {
  it('extracts text from string and block content', () => {
    expect(extractText(strMsg('user', 'hello'))).toBe('hello');
    expect(extractText(text('user', 'a'))).toBe('a');
    expect(extractText(toolUse())).toBe(''); // no text blocks
  });

  it('detects tool_use blocks', () => {
    expect(hasToolUse(strMsg('user', 'x'))).toBe(false);
    expect(hasToolUse(toolUse())).toBe(true);
    expect(hasToolUse(text('user', 'x'))).toBe(false);
  });

  it('detects large tool results (string and object content)', () => {
    expect(hasLargeToolResult(strMsg('user', 'x'))).toBe(false);
    expect(hasLargeToolResult(toolResult('a'.repeat(4000)))).toBe(true);
    expect(hasLargeToolResult(toolResult({ data: 'b'.repeat(4000) }))).toBe(true);
    expect(hasLargeToolResult(toolResult('short'))).toBe(false);
  });
});

describe('scoreMessage', () => {
  it('scores pure tool I/O as noise (0)', () => {
    expect(scoreMessage(toolUse())).toBe(0);
    expect(scoreMessage(toolResult(''))).toBe(0);
  });

  it('demotes repeated failures: 3rd-4th → 1, 5th+ → 0', () => {
    const failureCounts = new Map<string, number>();
    const fail = () => scoreMessage(text('user', 'Error: ENOENT happened'), { failureCounts });
    expect(fail()).toBe(5); // 1st (error keyword → critical) but failureCounts increments
    fail(); // 2nd
    expect(fail()).toBe(1); // 3rd
    fail(); // 4th
    expect(fail()).toBe(0); // 5th → noise
  });

  it('marks user corrections / stop signals as critical (5)', () => {
    expect(scoreMessage(text('user', 'no, stop that'))).toBe(5);
    expect(scoreMessage(text('user', 'actually revert that'))).toBe(5);
  });

  it('marks error, security, and architecture content as critical (5)', () => {
    expect(scoreMessage(text('assistant', 'a TypeError was thrown'))).toBe(5);
    expect(scoreMessage(text('assistant', 'found a SQL injection vulnerability'))).toBe(5);
    expect(scoreMessage(text('assistant', 'I will refactor the approach here'))).toBe(5);
  });

  it('marks large tool results and grep/list output as low (1)', () => {
    // A large tool result with accompanying text (a bare result with no text is noise).
    const bigWithText: Message = { role: 'user', content: [{ type: 'text', text: 'here is the output' }, { type: 'tool_result', tool_use_id: 'u1', content: 'z'.repeat(4000) }] } as Message;
    expect(scoreMessage(bigWithText)).toBe(1);
    expect(scoreMessage(text('user', 'found 12 match in the tree'))).toBe(1);
  });

  it('defaults to medium (3) for normal exchanges', () => {
    expect(scoreMessage(text('user', 'please add a button'))).toBe(3);
    expect(scoreMessage(text('assistant', 'Sure, here is the plan for it'))).toBe(3);
  });
});

describe('buildSmartDigest', () => {
  it('applies tiered treatment and collapses noise', () => {
    const longMedium = 'First sentence here. Second sentence that should be dropped from the digest entirely.';
    const messages: Message[] = [
      text('user', 'no, stop'), // 5 → verbatim
      text('assistant', longMedium), // 3 → first sentence
      text('user', 'found 7 match in the tree'), // 1 → one-line summary
      toolUse(), // 0 → noise collapsed
      toolUse(), // 0 → noise collapsed
    ];
    const digest = buildSmartDigest(messages);
    expect(digest).toContain('[user]: no, stop');
    expect(digest).toContain('First sentence here.');
    expect(digest).not.toContain('Second sentence');
    expect(digest).toContain('found 7 match');
    expect(digest).toContain('low-importance turn(s) collapsed');
  });

  it('truncates a long single-line low-priority result to one line', () => {
    const longGrep = `found 5 match: ${'a'.repeat(140)}`; // grep → score 1, >100 chars
    const digest = buildSmartDigest([text('user', longGrep)]);
    expect(digest).toContain('…'); // truncated
    expect(digest).toContain('found 5 match');
  });

  it('renders a tool-call marker and handles short text without a sentence break', () => {
    const m: Message = { role: 'assistant', content: [{ type: 'text', text: 'quick note' }, { type: 'tool_use', id: 'u1', name: 'bash', input: {} }] } as Message;
    const digest = buildSmartDigest([m]);
    expect(digest).toContain('[1 tool call(s)]');
    expect(digest).toContain('quick note');
  });
});

describe('buildSmartDigest empty / countToolBlocks edge', () => {
  it('skips a message whose display and tool count are both empty', () => {
    // empty string content → score 3, firstSentence('')='' , 0 tool blocks → skipped
    const digest = buildSmartDigest([strMsg('user', ''), text('user', 'real content here')]);
    expect(digest).toContain('real content here');
    expect(digest).not.toContain('[user]: \n'); // the empty one produced no line
  });
});

describe('eliseOldToolResults', () => {
  const big = (n: number): Message => ({ role: 'user', content: [{ type: 'text', text: 'output below' }, { type: 'tool_result', tool_use_id: 'u1', content: 'z'.repeat(n) }] }) as Message;

  it('elides oversized tool results before the preserved window, keeping text blocks', () => {
    const messages: Message[] = [big(8000), text('user', 'recent 1'), text('assistant', 'recent 2'), text('user', 'recent 3')];
    const res = eliseOldToolResults(messages, { preserveK: 2, eliseThreshold: 100 });
    expect(res.changed).toBe(true);
    expect(res.saved).toBeGreaterThan(0);
    const elided = res.messages[0];
    const blocks = Array.isArray(elided?.content) ? elided.content : [];
    expect(blocks.find((b) => b.type === 'text')).toBeDefined(); // text block preserved (passthrough)
    expect(JSON.stringify(blocks)).toContain('elided');
  });

  it('keeps semantic hints in elided tool result markers', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'u1',
            name: 'grep',
            content: `packages/core/src/execution/compactor.ts:12:boom\nError: failed to parse\n${'z'.repeat(8000)}`,
            is_error: true,
          },
        ],
      } as Message,
      text('user', 'recent'),
    ];

    const res = eliseOldToolResults(messages, { preserveK: 1, eliseThreshold: 100 });

    expect(res.changed).toBe(true);
    expect(JSON.stringify(res.messages[0])).toContain('tool=grep');
    expect(JSON.stringify(res.messages[0])).toContain('packages/core/src/execution/compactor.ts');
    expect(JSON.stringify(res.messages[0])).toContain('Error: failed to parse');
  });

  it('returns unchanged when nothing is oversized', () => {
    const messages: Message[] = [big(10), text('user', 'a'), text('user', 'b')];
    const res = eliseOldToolResults(messages, { preserveK: 1, eliseThreshold: 100000 });
    expect(res.changed).toBe(false);
    expect(res.saved).toBe(0);
  });

  it('logs a regression warning under WRONGSTACK_DEBUG when the inner ratio is high', () => {
    const prev = process.env.WRONGSTACK_DEBUG;
    process.env.WRONGSTACK_DEBUG = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 15 tool_result blocks on one message → fullPassInner/fullPass ratio > 10
      const blocks = Array.from({ length: 15 }, (_, i) => ({ type: 'tool_result' as const, tool_use_id: `u${i}`, content: i === 0 ? 'z'.repeat(8000) : 'small' }));
      const messages: Message[] = [{ role: 'user', content: blocks } as Message, text('user', 'recent')];
      eliseOldToolResults(messages, { preserveK: 1, eliseThreshold: 100 });
      expect(err).toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.WRONGSTACK_DEBUG;
      else process.env.WRONGSTACK_DEBUG = prev;
    }
  });
});

describe('buildLosslessDigest', () => {
  it('keeps text verbatim, marks tool-only messages, and skips empty ones', () => {
    const messages: Message[] = [
      text('user', 'keep this text'),
      toolUse('assistant'), // tool-only → omitted marker
      strMsg('assistant', ''), // empty + no tools → skipped
    ];
    const digest = buildLosslessDigest(messages);
    expect(digest).toContain('keep this text');
    expect(digest).toContain('tool call(s) omitted');
    expect(digest.split('\n').length).toBe(2); // only the text + tool-only lines
  });
});

describe('findPreserveStart', () => {
  it('walks back K user/assistant turns', () => {
    const messages: Message[] = [text('user', '1'), text('assistant', '2'), text('user', '3'), text('assistant', '4')];
    expect(findPreserveStart(messages, 2)).toBe(2);
    expect(findPreserveStart(messages, 10)).toBe(0); // more than available
  });
});

describe('findSafeBoundary / findExchangeStart', () => {
  it('finds the exchange start for the nearest user-with-text message', () => {
    const messages: Message[] = [
      text('user', 'first task'),
      toolUse('assistant'),
      text('assistant', 'done thinking'), // assistant, no tool use → boundary after it
      text('user', 'second task'),
      toolUse('assistant'),
    ];
    const b = findSafeBoundary(messages, 0, 4);
    expect(b).toBe(3); // start of the 'second task' exchange (after the no-tool assistant)
  });

  it('returns -1 when no user-with-text message exists in range', () => {
    expect(findSafeBoundary([toolUse(), toolUse()], 0, 1)).toBe(-1);
  });

  it('findExchangeStart stops at a prior user message and falls back to 0', () => {
    const messages: Message[] = [text('user', 'a'), text('user', 'b')];
    expect(findExchangeStart(messages, 1)).toBe(0); // prior user at index 0
    // only tool-use assistants before the user index → walk falls through to 0
    expect(findExchangeStart([toolUse('assistant'), toolUse('assistant')], 1)).toBe(0);
  });
});
