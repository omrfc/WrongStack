import { describe, expect, it } from 'vitest';
import { feedPaste } from '../src/paste-accumulator.js';

const BEGIN = '\x1b[200~';
const END = '\x1b[201~';

describe('feedPaste', () => {
  it('returns null for ordinary input when idle', () => {
    expect(feedPaste(null, 'hello')).toBeNull();
    expect(feedPaste(null, 'a')).toBeNull();
  });

  it('assembles a single-event bracketed paste in one shot', () => {
    const res = feedPaste(null, `${BEGIN}line1\nline2${END}`);
    expect(res).toEqual({ accum: null, complete: 'line1\nline2' });
  });

  it('buffers a paste split across multiple events and finalizes on the end marker', () => {
    let accum: string | null = null;
    const r1 = feedPaste(accum, `${BEGIN}first chunk\n`);
    expect(r1).toEqual({ accum: 'first chunk\n', complete: null });
    accum = r1?.accum ?? null;

    const r2 = feedPaste(accum, 'middle chunk\n');
    expect(r2).toEqual({ accum: 'first chunk\nmiddle chunk\n', complete: null });
    accum = r2?.accum ?? null;

    const r3 = feedPaste(accum, `last chunk${END}`);
    expect(r3).toEqual({ accum: null, complete: 'first chunk\nmiddle chunk\nlast chunk' });
  });

  it('handles bare markers when the terminal/Ink dropped the ESC byte', () => {
    const res = feedPaste(null, '[200~pasted text[201~');
    expect(res).toEqual({ accum: null, complete: 'pasted text' });
  });

  it('treats a mid-paste fragment of just a newline as paste content, not Enter', () => {
    const r1 = feedPaste(null, `${BEGIN}a`);
    expect(r1?.complete).toBeNull();
    const r2 = feedPaste(r1?.accum ?? null, '\n');
    expect(r2).toEqual({ accum: 'a\n', complete: null });
    const r3 = feedPaste(r2?.accum ?? null, `b${END}`);
    expect(r3).toEqual({ accum: null, complete: 'a\nb' });
  });

  it('strips begin and end markers even when both arrive in the same later fragment', () => {
    const r1 = feedPaste(null, `${BEGIN}x`);
    const r2 = feedPaste(r1?.accum ?? null, `y${END}`);
    expect(r2).toEqual({ accum: null, complete: 'xy' });
  });
});
