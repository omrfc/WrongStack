import { describe, expect, it } from 'vitest';
import { deleteTokenBackward, splitChips, tokenLengthForward } from '../src/input-tokens.js';

describe('deleteTokenBackward', () => {
  it('deletes a whole pasted chip ending at the cursor', () => {
    const buffer = 'hi [pasted #1, 12 lines]';
    const res = deleteTokenBackward(buffer, buffer.length);
    expect(res).toEqual({ buffer: 'hi ', cursor: 3 });
  });

  it('deletes a chip in the MIDDLE of the line (cursor just past it)', () => {
    const buffer = 'a [file:src/x.ts] b';
    const cursor = 'a [file:src/x.ts]'.length; // right after the chip
    const res = deleteTokenBackward(buffer, cursor);
    expect(res).toEqual({ buffer: 'a  b', cursor: 2 });
  });

  it('deletes a legacy `[file #1]` chip', () => {
    const buffer = 'see [file #1]';
    const res = deleteTokenBackward(buffer, buffer.length);
    expect(res).toEqual({ buffer: 'see ', cursor: 4 });
  });

  it('deletes a file chip with an absolute / nested / spaced path', () => {
    for (const tok of [
      '[file:d:/Codebox/PROJECTS/WrongStack/packages/tui/src/app.tsx]',
      '[file:packages/core/src/agent.ts]',
      '[file:my folder/a.ts]',
    ]) {
      const buffer = `hi ${tok}`;
      const res = deleteTokenBackward(buffer, buffer.length);
      expect(res).toEqual({ buffer: 'hi ', cursor: 3 });
    }
  });

  it('returns null when no chip ends at the cursor (plain char delete)', () => {
    expect(deleteTokenBackward('hello', 5)).toBeNull();
    // Cursor inside a chip — not a clean end boundary.
    const buffer = '[pasted #1, 5 lines]';
    expect(deleteTokenBackward(buffer, buffer.length - 1)).toBeNull();
  });
});

describe('tokenLengthForward', () => {
  it('returns the chip length when a chip starts at the cursor', () => {
    const buffer = 'x [image #2, PNG] y';
    const cursor = 'x '.length;
    expect(tokenLengthForward(buffer, cursor)).toBe('[image #2, PNG]'.length);
  });

  it('returns 0 when no chip starts at the cursor', () => {
    expect(tokenLengthForward('plain text', 0)).toBe(0);
  });
});

describe('splitChips', () => {
  it('splits plain text + chips into ordered spans', () => {
    const spans = splitChips('hello [pasted #1, 3 lines] world [file:a.ts]');
    expect(spans).toEqual([
      { text: 'hello ', chip: false },
      { text: '[pasted #1, 3 lines]', chip: true },
      { text: ' world ', chip: false },
      { text: '[file:a.ts]', chip: true },
    ]);
  });

  it('returns a single plain span when there are no chips', () => {
    expect(splitChips('just words')).toEqual([{ text: 'just words', chip: false }]);
  });

  it('returns an empty array for empty input', () => {
    expect(splitChips('')).toEqual([]);
  });
});
