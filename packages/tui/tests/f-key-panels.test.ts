import { describe, expect, it } from 'vitest';
import { F_KEY_PANEL_ENTRIES, actionForFKeyPanel } from '../src/f-key-panels.js';
import type { StatuslineItem } from '../src/components/statusline-picker.js';

const entry = (key: number) => {
  const found = F_KEY_PANEL_ENTRIES.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Missing F${key} entry`);
  return found;
};

describe('actionForFKeyPanel', () => {
  it('returns null for F1 because project items must be loaded by the host first', () => {
    expect(actionForFKeyPanel(entry(1))).toBeNull();
  });

  it('returns payload-free reducer actions for ordinary panel toggles', () => {
    expect(actionForFKeyPanel(entry(5))).toEqual({ type: 'togglePlanPanel' });
    expect(actionForFKeyPanel(entry(11))).toEqual({ type: 'toggleCoordinatorMonitor' });
  });

  it('adds hidden statusline items when opening F12', () => {
    expect(actionForFKeyPanel(entry(12), ['todos', 'cost'])).toEqual({
      type: 'statuslineOpen',
      hiddenItems: ['todos', 'cost'],
    });
  });

  it('copies hidden statusline items instead of reusing the caller array', () => {
    const hidden: StatuslineItem[] = ['todos'];
    const action = actionForFKeyPanel(entry(12), hidden);
    hidden.push('cost');

    expect(action).toEqual({ type: 'statuslineOpen', hiddenItems: ['todos'] });
  });
});
