import { describe, expect, it, vi } from 'vitest';
import {
  type CommitLLMProvider,
  generateCommitMessageWithLLM,
} from '../src/slash-commands/commit-llm.js';

const okProvider = (text: string): CommitLLMProvider => ({
  complete: vi.fn(async () => ({
    content: [{ type: 'text' as const, text }],
    model: 'test-model',
  })),
});

describe('generateCommitMessageWithLLM', () => {
  it('returns the trimmed first line of the LLM response', async () => {
    const provider = okProvider('feat(cli): add commit LLM\nrest is ignored');
    const out = await generateCommitMessageWithLLM('diff content', {
      provider,
      model: 'm',
    });
    expect(out).toBe('feat(cli): add commit LLM');
  });

  it('trims surrounding whitespace from the message', async () => {
    const provider = okProvider('   fix: typo   ');
    const out = await generateCommitMessageWithLLM('diff', { provider, model: 'm' });
    expect(out).toBe('fix: typo');
  });

  it('forwards the model, maxTokens, temperature and system prompt', async () => {
    const provider = okProvider('feat: x');
    await generateCommitMessageWithLLM('the diff', { provider, model: 'gpt-4o-mini' });
    const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].model).toBe('gpt-4o-mini');
    expect(call[0].maxTokens).toBe(80);
    expect(call[0].temperature).toBe(0.3);
    expect(call[0].system?.[0].text).toMatch(/conventional-commit/);
    expect(call[0].messages[0].content[0].text).toContain('the diff');
    expect(call[1].signal).toBeDefined();
  });

  it('falls back to "chore: update" when the LLM returns an empty string', async () => {
    const provider = okProvider('');
    const out = await generateCommitMessageWithLLM('diff', { provider, model: 'm' });
    expect(out).toBe('chore: update');
  });

  it('falls back when the LLM message exceeds 200 chars', async () => {
    const longLine = 'feat: '.padEnd(250, 'x');
    const provider = okProvider(longLine);
    const out = await generateCommitMessageWithLLM('diff', { provider, model: 'm' });
    expect(out).toBe('chore: update');
  });

  it('falls back when the provider rejects', async () => {
    const provider: CommitLLMProvider = {
      complete: vi.fn(async () => {
        throw new Error('upstream down');
      }),
    };
    const out = await generateCommitMessageWithLLM('diff', { provider, model: 'm' });
    expect(out).toBe('chore: update');
  });

  it('accepts a single-block content shape (non-array fallback path)', async () => {
    const provider: CommitLLMProvider = {
      complete: vi.fn(async () => ({
        // The runtime narrows `Array.isArray` first; this shape exercises
        // the non-array branch where content is an object with .text.
        content: { type: 'text', text: 'docs: update README' } as never,
        model: 'm',
      })),
    };
    const out = await generateCommitMessageWithLLM('diff', { provider, model: 'm' });
    expect(out).toBe('docs: update README');
  });

  it('passes an AbortSignal so the call can be cancelled', async () => {
    const provider = okProvider('feat: x');
    await generateCommitMessageWithLLM('diff', { provider, model: 'm' });
    const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].signal.aborted).toBe(false);
  });
});
