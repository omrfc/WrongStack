import { describe, expect, it } from 'vitest';
import type { FleetEntry } from '../src/app-reducer.js';
import { activityStripRows } from '../src/components/live-activity-strip.js';

// Regression: the live-activity strip (one row per running subagent, sitting
// directly above the input) must render at a CONSTANT height with every row
// hard-truncated to the terminal width. A bottom live region whose height or
// visual-row count changes between renders scrolls the screen on every update,
// and in inline mode each scroll strands the changed rows into native
// scrollback — the bug where "● Security Scanner …" gets re-stamped into
// history dozens of times per second while a fleet is busy.

function mkEntry(over: Partial<FleetEntry> & { id: string }): FleetEntry {
  return {
    name: over.id,
    status: 'running',
    streamingText: '',
    iterations: 0,
    toolCalls: 0,
    recentTools: [],
    recentMessages: [],
    cost: 0,
    startedAt: 0,
    lastEventAt: 0,
    ...over,
  };
}

const NOW = 60_000;

describe('activityStripRows (constant-height live-activity strip)', () => {
  it('always returns exactly maxRows rows regardless of fleet size', () => {
    const cases: Record<string, FleetEntry>[] = [
      {},
      { a: mkEntry({ id: 'a' }) },
      { a: mkEntry({ id: 'a' }), b: mkEntry({ id: 'b' }) },
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`s${i}`, mkEntry({ id: `s${i}`, startedAt: i })]),
      ),
    ];
    for (const entries of cases) {
      expect(activityStripRows(entries, NOW, 4, 100)).toHaveLength(4);
    }
  });

  it('pads blank rows on top so a single subagent still fills the height', () => {
    const rows = activityStripRows({ a: mkEntry({ id: 'a' }) }, NOW, 4, 100);
    expect(rows.filter((r) => r === '')).toHaveLength(3);
    expect(rows.some((r) => r.startsWith('a'))).toBe(true);
  });

  it('only counts running subagents — idle/finished ones are excluded', () => {
    const rows = activityStripRows(
      {
        a: mkEntry({ id: 'a', status: 'success' }),
        b: mkEntry({ id: 'b', status: 'running' }),
      },
      NOW,
      4,
      100,
    );
    expect(rows.filter((r) => r !== '')).toHaveLength(1);
    expect(rows.some((r) => r.startsWith('b'))).toBe(true);
  });

  it('overflow reserves the last row for a "+N more" count and keeps height fixed', () => {
    const entries = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`s${i}`, mkEntry({ id: `s${i}`, startedAt: i })]),
    );
    const rows = activityStripRows(entries, NOW, 4, 100);
    expect(rows).toHaveLength(4);
    // 10 running, 4 rows → 3 agent rows + 1 overflow row → +7 more.
    expect(rows[3]).toContain('…+7 more');
  });

  it('truncates rows wider than the content width (no wrap)', () => {
    const entry = mkEntry({
      id: 'really-long-subagent-name-that-keeps-going',
      recentTools: [{ name: 'x'.repeat(40), ok: true, durationMs: 1234, outputBytes: 9999, at: 0 }],
    });
    const rows = activityStripRows({ a: entry }, NOW, 4, 40);
    const content = rows.find((r) => r !== '')!;
    // bodyWidth = width - 2 (the "● " bullet rendered by the component).
    expect(content.length).toBeLessThanOrEqual(38);
    expect(content.endsWith('…')).toBe(true);
  });
});
