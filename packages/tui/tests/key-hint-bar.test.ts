import { describe, expect, it } from 'vitest';
import { hintsFor } from '../src/components/key-hint-bar.js';

const keys = (ctx: Parameters<typeof hintsFor>[0]) => hintsFor(ctx).map((h) => h.key);

describe('KeyHintBar context priority', () => {
  it('confirm wins over everything', () => {
    expect(keys({ confirm: true, picker: true, monitor: true })).toEqual(['y', 'n', 'a', 'd']);
  });

  it('picker shows move/select/cancel; adds click in mouse mode', () => {
    expect(keys({ picker: true })).toEqual(['↑↓', '↵', 'Esc']);
    expect(keys({ picker: true, mouse: true })).toContain('click');
  });

  it('monitor shows close + switch keys', () => {
    expect(keys({ monitor: true })).toContain('Esc');
    expect(keys({ monitor: true })).toContain('^F');
  });

  it('idle shows /help and stop; adds scroll hints by capability', () => {
    expect(keys({})).toEqual(['/help', '^G', '^C']);
    expect(keys({ managed: true })).toContain('PgUp/PgDn');
    expect(keys({ mouse: true })).toContain('wheel');
  });
});
