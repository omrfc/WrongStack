import { describe, expect, it } from 'vitest';
import { shortenPath } from '../src/components/history.js';

describe('shortenPath (banner cwd)', () => {
  it('returns the path unchanged when within the budget', () => {
    expect(shortenPath('/tmp/x', 32)).toBe('/tmp/x');
  });

  it('keeps the tail and prefixes with an ellipsis when over the budget', () => {
    const out = shortenPath('/aaa/bbb/ccc/ddd/eee/fff/ggg', 16);
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out.startsWith('…')).toBe(true);
    // The end of the path (closest to the user's actual working dir)
    // is preserved.
    expect(out.endsWith('ggg')).toBe(true);
  });

  it('honours the exact width budget down to the ellipsis character', () => {
    // 20-char path, 10-char budget → 1 ellipsis + 9 chars of tail.
    expect(shortenPath('abcdefghij1234567890', 10)).toBe('…2345678​90'.replace('​', ''));
    // simpler: check it's 10 chars and starts with ellipsis.
    const out = shortenPath('abcdefghij1234567890', 10);
    expect(out.length).toBe(10);
    expect(out[0]).toBe('…');
  });

  it('treats an empty string as a no-op', () => {
    expect(shortenPath('', 10)).toBe('');
  });
});
