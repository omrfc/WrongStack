import { describe, expect, it } from 'vitest';
import { helpSections } from '../src/components/help-overlay.js';

const flat = (opts: { managed: boolean }) =>
  helpSections(opts).flatMap((s) => s.entries.map((e) => e.keys));

describe('helpSections', () => {
  it('always groups the four areas in order', () => {
    const titles = helpSections({ managed: false }).map((s) => s.title);
    expect(titles).toEqual(['Navigation', 'Monitors', 'Editing', 'Commands']);
  });

  it('always lists the monitor + help keys', () => {
    const keys = flat({ managed: false });
    // Monitor chords are listed with their terminal-safe F-key aliases.
    expect(keys).toContain('Ctrl+F / F2');
    expect(keys).toContain('Ctrl+G / F3');
    expect(keys).toContain('Ctrl+T / F4');
    expect(keys).toContain('?');
    expect(keys).toContain('/help');
    expect(keys).toContain('Ctrl+S');
    expect(keys).toContain('/settings');
  });

  it('adds PgUp/PgDn only in the managed viewport', () => {
    expect(flat({ managed: false })).not.toContain('PgUp/PgDn   ↕ wheel');
    expect(flat({ managed: true })).toContain('PgUp/PgDn   ↕ wheel');
  });

  it('never produces an empty section', () => {
    for (const opts of [
      { managed: false },
      { managed: true },
    ]) {
      for (const sec of helpSections(opts)) {
        expect(sec.entries.length).toBeGreaterThan(0);
      }
    }
  });
});
