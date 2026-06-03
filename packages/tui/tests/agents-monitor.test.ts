import { describe, expect, it } from 'vitest';
import type { FleetEntry } from '../src/app.js';
import { IDLE_HIDE_MS, fmtExactTokens, selectLiveAgents } from '../src/components/agents-monitor.js';
import { bucketActivity, sparkline } from '../src/components/fleet-monitor.js';

function entry(over: Partial<FleetEntry> & Pick<FleetEntry, 'id' | 'status'>): FleetEntry {
  return {
    name: over.id,
    status: over.status,
    streamingText: '',
    iterations: 0,
    toolCalls: 0,
    recentTools: [],
    recentMessages: [],
    cost: 0,
    startedAt: 0,
    lastEventAt: 0,
    ...over,
  } as FleetEntry;
}

describe('selectLiveAgents', () => {
  const now = 1_000_000;

  it('always keeps running agents and excludes terminal ones', () => {
    const agents = [
      entry({ id: 'run', status: 'running' }),
      entry({ id: 'ok', status: 'success' }),
      entry({ id: 'bad', status: 'failed' }),
      entry({ id: 'to', status: 'timeout' }),
      entry({ id: 'stop', status: 'stopped' }),
    ];
    const ids = selectLiveAgents(agents, now).map((e) => e.id);
    expect(ids).toEqual(['run']);
  });

  it('keeps recently-active idle agents but prunes stale ones', () => {
    const agents = [
      entry({ id: 'fresh', status: 'idle', lastEventAt: now - 5_000 }),
      entry({ id: 'stale', status: 'idle', lastEventAt: now - (IDLE_HIDE_MS + 1) }),
    ];
    const ids = selectLiveAgents(agents, now).map((e) => e.id);
    expect(ids).toContain('fresh');
    expect(ids).not.toContain('stale');
  });

  it('never prunes a running agent regardless of how long since its last event', () => {
    const agents = [entry({ id: 'run', status: 'running', lastEventAt: now - 10 * IDLE_HIDE_MS })];
    expect(selectLiveAgents(agents, now).map((e) => e.id)).toEqual(['run']);
  });

  it('orders running first (oldest run first), then freshest idle', () => {
    const agents = [
      entry({ id: 'idle-old', status: 'idle', lastEventAt: now - 20_000 }),
      entry({ id: 'idle-new', status: 'idle', lastEventAt: now - 1_000 }),
      entry({ id: 'run-new', status: 'running', startedAt: now - 1_000, lastEventAt: now }),
      entry({ id: 'run-old', status: 'running', startedAt: now - 50_000, lastEventAt: now }),
    ];
    expect(selectLiveAgents(agents, now).map((e) => e.id)).toEqual([
      'run-old',
      'run-new',
      'idle-new',
      'idle-old',
    ]);
  });

  it('respects a custom idleHideMs threshold', () => {
    const agents = [entry({ id: 'i', status: 'idle', lastEventAt: now - 5_000 })];
    expect(selectLiveAgents(agents, now, 4_000).map((e) => e.id)).toEqual([]);
    expect(selectLiveAgents(agents, now, 6_000).map((e) => e.id)).toEqual(['i']);
  });
});

describe('agents-monitor formatting', () => {
  it('renders exact model context windows instead of compact abbreviations', () => {
    expect(fmtExactTokens(1_050_000)).toBe('1,050,000 tok');
    expect(fmtExactTokens(128_000)).toBe('128,000 tok');
  });
});

describe('agents-monitor import re-exports', () => {
  it('re-exports bucketActivity from fleet-monitor', () => {
    expect(typeof bucketActivity).toBe('function');
  });

  it('re-exports sparkline from fleet-monitor', () => {
    expect(typeof sparkline).toBe('function');
  });
});

describe('bucketActivity (via fleet-monitor re-export)', () => {
  it('buckets tool timestamps into the trailing window', () => {
    const now = 100_000;
    // bins=5, binMs=2000 → window is [90_000, 100_000].
    const tools = [
      { at: 99_500 }, // last bin
      { at: 99_000 }, // last bin
      { at: 91_000 }, // first bin
      { at: 50_000 }, // out of window — ignored
    ];
    const out = bucketActivity(tools, now, 5, 2000);
    expect(out.length).toBe(5);
    expect(out[0]).toBe(1); // 91_000
    expect(out[4]).toBe(2); // 99_000 + 99_500
    expect(out.reduce((a, b) => a + b, 0)).toBe(3); // 50_000 excluded
  });

  it('returns all-zero for no recent activity', () => {
    expect(bucketActivity([], 1000, 4, 1000)).toEqual([0, 0, 0, 0]);
  });
});

describe('sparkline (via fleet-monitor re-export)', () => {
  it('returns empty string for empty input', () => {
    expect(sparkline([])).toBe('');
  });

  it('maps zero to the lowest glyph and the max to the highest', () => {
    const out = sparkline([0, 1, 2, 4, 8]);
    expect(out[0]).toBe('▁'); // zero
    expect(out[out.length - 1]).toBe('█'); // max
    expect(out.length).toBe(5);
  });

  it('scales relative to the series max', () => {
    const flat = sparkline([3, 3, 3]);
    // all equal to max → all full bars
    expect(flat).toBe('███');
  });
});
