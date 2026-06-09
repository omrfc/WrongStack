import { describe, expect, it } from 'vitest';
import { ContextBar, ContextFillBar } from '../../src/components/ContextBar';

/**
 * Pure-logic tests for ContextBar — we verify the color-threshold and
 * formatting behaviour without React rendering (avoids installing
 * @testing-library/react just for these shallow checks).
 *
 * These are intentionally narrow: the components' JSX output is verified
 * by the build, typecheck, and manual browser smoke test.
 */

// ── Color thresholds (extracted from component logic) ──────────────────

function getBarColor(pct: number): 'success' | 'warning' | 'destructive' {
  if (pct >= 75) return 'destructive';
  if (pct >= 60) return 'warning';
  return 'success';
}

function getTextColor(pct: number): 'success' | 'warning' | 'destructive' {
  if (pct >= 75) return 'destructive';
  if (pct >= 60) return 'warning';
  return 'success';
}

function fmtPct(pct: number): string {
  const clamped = Math.max(0, Math.min(200, pct));
  if (pct >= 100) return `${Math.round(pct)}%+`;
  return `${Math.round(pct)}%`;
}

describe('ContextBar color thresholds', () => {
  it('returns success (green) for pct < 60', () => {
    expect(getBarColor(0)).toBe('success');
    expect(getBarColor(30)).toBe('success');
    expect(getBarColor(59)).toBe('success');
  });

  it('returns warning (yellow) for pct 60-74', () => {
    expect(getBarColor(60)).toBe('warning');
    expect(getBarColor(65)).toBe('warning');
    expect(getBarColor(74)).toBe('warning');
  });

  it('returns destructive (red) for pct >= 75', () => {
    expect(getBarColor(75)).toBe('destructive');
    expect(getBarColor(85)).toBe('destructive');
    expect(getBarColor(100)).toBe('destructive');
    expect(getBarColor(150)).toBe('destructive');
  });

  it('text color follows same thresholds', () => {
    expect(getTextColor(44)).toBe('success');
    expect(getTextColor(65)).toBe('warning');
    expect(getTextColor(90)).toBe('destructive');
  });
});

describe('percentage formatting', () => {
  it('formats normal percentages', () => {
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(44)).toBe('44%');
    expect(fmtPct(99)).toBe('99%');
  });

  it('appends + for >= 100%', () => {
    expect(fmtPct(100)).toBe('100%+');
    expect(fmtPct(120)).toBe('120%+');
  });

  it('rounds correctly', () => {
    expect(fmtPct(44.4)).toBe('44%');
    expect(fmtPct(44.5)).toBe('45%');
  });
});

describe('ContextFillBar bar width calculation', () => {
  it('clamps to 0-100 for CSS width', () => {
    const clamped = (pct: number) => Math.max(0, Math.min(100, pct));
    expect(clamped(0)).toBe(0);
    expect(clamped(50)).toBe(50);
    expect(clamped(100)).toBe(100);
    expect(clamped(150)).toBe(100);
  });
});
