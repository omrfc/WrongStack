import { describe, expect, it } from 'vitest';
import { tailForDisplay } from '../src/components/history.js';

describe('tailForDisplay (streaming buffer cap)', () => {
  it('passes short text through unchanged', () => {
    expect(tailForDisplay('hello', 100)).toBe('hello');
  });

  it('caps text at the requested length with an ellipsis marker', () => {
    const long = 'x'.repeat(1000);
    const out = tailForDisplay(long, 200);
    expect(out.startsWith('… ')).toBe(true);
    // … + space + 200 chars = 202
    expect(out.length).toBeLessThanOrEqual(202);
  });

  it('prefers a newline boundary near the cut for a clean visual edge', () => {
    const head = 'old paragraph that should be dropped';
    const body = 'live paragraph that is being typed right now';
    const text = `${head}\n${body}`;
    const out = tailForDisplay(text, body.length + 5);
    expect(out).toBe(`… ${body}`);
  });

  it('falls back to a hard char cut when no nearby newline exists', () => {
    const text = 'A'.repeat(100) + 'B'.repeat(500);
    const out = tailForDisplay(text, 200);
    // No newline anywhere in the buffer, so we land on the hard cut.
    expect(out).toMatch(/^… B+$/);
    expect(out.length).toBeLessThanOrEqual(202);
  });

  it('treats empty input as empty (idempotent)', () => {
    expect(tailForDisplay('', 100)).toBe('');
  });
});
