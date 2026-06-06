import { describe, expect, it } from 'vitest';
import { assistantTailRows, streamBoxRows } from '../src/components/history.js';

// Regression: the live tool-stream box and assistant tail must render at a
// CONSTANT height regardless of how much text is streaming. A region that grows
// row-by-row at the bottom of the terminal scrolls the screen on every update,
// and in inline (non-alt-screen) mode each scroll leaks the top row into
// permanent scrollback — the bug where "◆ bash ⏱ …" and the input prompt get
// re-stamped into history dozens of times per turn.

describe('streamBoxRows (constant-height tool stream)', () => {
  it('always returns exactly maxLines rows regardless of input length', () => {
    for (const text of ['', 'one', 'a\nb\nc', Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')]) {
      expect(streamBoxRows(text, 8, 100)).toHaveLength(8);
    }
  });

  it('bottom-pins content: short input pads blank rows on top', () => {
    const rows = streamBoxRows('x\ny', 8, 100);
    expect(rows.slice(0, 6).every((r) => r.text === '')).toBe(true);
    expect(rows[6]!.text).toBe('x');
    expect(rows[7]!.text).toBe('y');
  });

  it('overflow shows a "more above" marker as the first row and keeps height fixed', () => {
    const text = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
    const rows = streamBoxRows(text, 8, 100);
    expect(rows).toHaveLength(8);
    expect(rows[0]!.italic).toBe(true);
    expect(rows[0]!.text).toContain('more line');
    // Last 7 source lines are shown after the marker.
    expect(rows[7]!.text).toBe('L19');
  });

  it('truncates lines wider than contentWidth (no wrap)', () => {
    const rows = streamBoxRows('y'.repeat(200), 8, 40);
    const content = rows.find((r) => r.text.includes('y'))!;
    expect(content.text.length).toBeLessThanOrEqual(40);
    expect(content.text.endsWith('…')).toBe(true);
  });
});

describe('assistantTailRows (constant-height assistant tail)', () => {
  it('always returns exactly tailLines rows regardless of input length', () => {
    for (const text of ['', 'hi', 'a\nb', Array.from({ length: 40 }, (_, i) => `p${i}`).join('\n')]) {
      expect(assistantTailRows(text, 8, 120)).toHaveLength(8);
    }
  });

  it('bottom-pins the newest lines with blank padding on top', () => {
    const rows = assistantTailRows('first\nsecond', 8, 120);
    expect(rows.slice(0, 6).every((r) => r === '')).toBe(true);
    expect(rows[6]).toBe('first');
    expect(rows[7]).toBe('second');
  });

  it('keeps only the last tailLines when input overflows', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const rows = assistantTailRows(text, 8, 120);
    expect(rows[0]).toBe('line12');
    expect(rows[7]).toBe('line19');
  });

  it('truncates lines wider than contentWidth (no wrap)', () => {
    const rows = assistantTailRows('z'.repeat(300), 8, 50);
    const content = rows.find((r) => r.includes('z'))!;
    expect(content.length).toBeLessThanOrEqual(50);
    expect(content.endsWith('…')).toBe(true);
  });
});
