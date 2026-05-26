import { describe, expect, it } from 'vitest';
import { bucketActivity, sparkline } from '../src/components/fleet-monitor.js';

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