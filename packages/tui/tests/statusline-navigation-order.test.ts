import { describe, expect, it } from 'vitest';
import { STATUSLINE_ITEMS, STATUSLINE_FIELD_COUNT, ITEM_LINE } from '../src/components/statusline-picker.js';

/**
 * Navigation order must match the visual layout order.
 * The picker groups items by their status-bar line (1-4) and shows
 * them in section order. Up/Down arrow keys cycle through STATUSLINE_ITEMS
 * by index, so the array order must match the visual top-to-bottom order.
 */
describe('STATUSLINE_ITEMS navigation order matches visual layout', () => {
  it('has exactly 35 fields', () => {
    expect(STATUSLINE_ITEMS.length).toBe(35);
    expect(STATUSLINE_FIELD_COUNT).toBe(35);
  });

  it('follows line 1 → line 2 → line 3 → line 4 order', () => {
    const lines = STATUSLINE_ITEMS.map((item) => ITEM_LINE[item]);

    // All line 1 items come first
    const line1End = lines.findIndex((l) => l !== 1);
    expect(lines.slice(0, line1End).every((l) => l === 1)).toBe(true);

    // Then all line 2 items
    const line2Start = line1End;
    const line2End = lines.findIndex((l, i) => i >= line2Start && l !== 2);
    expect(lines.slice(line2Start, line2End).every((l) => l === 2)).toBe(true);

    // Then all line 3 items
    const line3Start = line2End;
    const line3End = lines.findIndex((l, i) => i >= line3Start && l !== 3);
    expect(lines.slice(line3Start, line3End).every((l) => l === 3)).toBe(true);

    // Then line 4 items
    const line4Start = line3End;
    expect(lines.slice(line4Start).every((l) => l === 4)).toBe(true);
  });

  it('is alphabetically sorted within each line', () => {
    // Group by line
    const byLine = new Map<number, string[]>();
    for (const item of STATUSLINE_ITEMS) {
      const line = ITEM_LINE[item];
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line)!.push(item);
    }

    // Each group should be alphabetically sorted
    for (const [_line, items] of byLine) {
      const sorted = [...items].sort((a, b) => a.localeCompare(b));
      expect(items).toEqual(sorted);
    }
  });

  it('has no duplicate items', () => {
    const unique = new Set(STATUSLINE_ITEMS);
    expect(unique.size).toBe(STATUSLINE_ITEMS.length);
  });

  it('includes every statusline item exactly once', () => {
    const expected = [
      'auto_proceed', 'autonomy', 'brain', 'breaker', 'cache',
      'context', 'cost', 'debug_stream', 'elapsed', 'enhance',
      'eternal_stage', 'fleet', 'fleet_agents', 'git', 'goal',
      'hint', 'index', 'mailbox', 'mode', 'model',
      'next_steps', 'plan', 'processes', 'project', 'queue',
      'sessions', 'state', 'tasks', 'token_saving', 'tokens',
      'todos', 'tools', 'version', 'working_dir', 'yolo',
    ].sort();
    const actual = [...STATUSLINE_ITEMS].sort();
    expect(actual).toEqual(expected);
  });
});
