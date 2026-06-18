import { describe, expect, it } from 'vitest';
import { helpSections } from '../src/components/help-overlay.js';

const flat = () =>
  helpSections().flatMap((s) => s.entries.map((e) => e.keys));

describe('helpSections', () => {
  it('always groups the areas in order', () => {
    const titles = helpSections().map((s) => s.title);
    expect(titles).toEqual(['Navigation', 'Monitors', 'Editing', 'Commands', 'Tool Colors']);
  });

  it('always lists the monitor + help keys', () => {
    const keys = flat();
    // Monitor chords are listed with their terminal-safe F-key aliases.
    expect(keys).toContain('Ctrl+F / F2');
    expect(keys).toContain('Ctrl+G / F3');
    expect(keys).toContain('Ctrl+T / F4');
    expect(keys).toContain('?');
    expect(keys).toContain('/help');
    expect(keys).toContain('Ctrl+S');
    expect(keys).toContain('/settings');
  });

  it('never produces an empty section', () => {
    for (const sec of helpSections()) {
      expect(sec.entries.length).toBeGreaterThan(0);
    }
  });
});
