import { describe, it, expect } from 'vitest';
import { fmtElapsed, renderProgress } from '../src/components/status-bar.js';

describe('fmtElapsed', () => {
  it('renders mm:ss under one hour', () => {
    expect(fmtElapsed(0)).toBe('00:00');
    expect(fmtElapsed(5_000)).toBe('00:05');
    expect(fmtElapsed(65_000)).toBe('01:05');
    expect(fmtElapsed(59 * 60_000 + 30_000)).toBe('59:30');
  });

  it('switches to h:mm:ss at exactly one hour', () => {
    expect(fmtElapsed(60 * 60_000)).toBe('1:00:00');
    expect(fmtElapsed(60 * 60_000 + 1_000)).toBe('1:00:01');
    expect(fmtElapsed(3 * 60 * 60_000 + 15 * 60_000 + 7_000)).toBe('3:15:07');
  });

  it('rounds milliseconds down (floor)', () => {
    expect(fmtElapsed(999)).toBe('00:00');
    expect(fmtElapsed(1_999)).toBe('00:01');
  });

  it('pads seconds and minutes with leading zeros under an hour', () => {
    expect(fmtElapsed(3_000)).toBe('00:03');
    expect(fmtElapsed(63_000)).toBe('01:03');
  });
});

describe('renderProgress', () => {
  it('renders an empty bar at ratio 0', () => {
    expect(renderProgress(0, 10)).toBe('░░░░░░░░░░');
  });

  it('renders a full bar at ratio 1', () => {
    expect(renderProgress(1, 10)).toBe('██████████');
  });

  it('shows at least one filled cell for any non-zero ratio (so 1% != 0%)', () => {
    const bar = renderProgress(0.01, 10);
    expect(bar.startsWith('█')).toBe(true);
    expect(bar.length).toBe(10);
  });

  it('rounds 50% to 5 of 10 cells', () => {
    expect(renderProgress(0.5, 10)).toBe('█████░░░░░');
  });

  it('clamps ratios outside [0,1]', () => {
    expect(renderProgress(-0.5, 8)).toBe('░░░░░░░░');
    expect(renderProgress(1.7, 8)).toBe('████████');
  });

  it('keeps total width stable across all ratios', () => {
    for (let i = 0; i <= 10; i++) {
      expect(renderProgress(i / 10, 12).length).toBe(12);
    }
  });
});
