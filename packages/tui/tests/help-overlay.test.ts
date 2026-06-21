import { describe, expect, it } from 'vitest';
import { F_KEY_ENTRIES } from '../src/components/f-key-picker.js';
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

  it('lists every F-key panel entry advertised by the F-key picker', () => {
    const keys = flat();
    for (const entry of F_KEY_ENTRIES) {
      const keyLabel = `F${entry.key}`;
      expect(keys.some((key) => key.includes(keyLabel))).toBe(true);
    }
  });

  it('keeps F5 and F12 labels aligned with their implemented panels', () => {
    const f5 = F_KEY_ENTRIES.find((entry) => entry.key === 5);
    const f12 = F_KEY_ENTRIES.find((entry) => entry.key === 12);
    expect(f5).toMatchObject({ label: 'Plan panel', action: 'togglePlanPanel' });
    expect(f12).toMatchObject({ label: 'Status line picker', action: 'statuslineOpen' });

    const monitorEntries = helpSections().find((section) => section.title === 'Monitors')?.entries ?? [];
    expect(monitorEntries).toContainEqual({ keys: 'F5', desc: 'plan panel' });
    expect(monitorEntries).toContainEqual({ keys: 'F12', desc: 'status line picker' });
  });

  it('never produces an empty section', () => {
    for (const sec of helpSections()) {
      expect(sec.entries.length).toBeGreaterThan(0);
    }
  });
});
