import { describe, expect, it } from 'vitest';
import {
  formatContextWindowModeList,
  getContextWindowMode,
  listContextWindowModes,
  resolveContextWindowPolicy,
} from '../../src/types/context-window.js';

describe('context window modes', () => {
  it('lists built-in modes', () => {
    expect(listContextWindowModes().map((m) => m.id)).toEqual([
      'balanced',
      'frugal',
      'deep',
      'archival',
    ]);
  });

  it('resolves balanced mode with config overrides', () => {
    const policy = resolveContextWindowPolicy({
      mode: 'balanced',
      warnThreshold: 0.5,
      softThreshold: 0.7,
      hardThreshold: 0.9,
      preserveK: 12,
      eliseThreshold: 1500,
    });
    expect(policy.thresholds.warn).toBe(0.5);
    expect(policy.preserveK).toBe(12);
    expect(policy.eliseThreshold).toBe(1500);
  });

  it('uses non-default mode policy as a preset', () => {
    const policy = resolveContextWindowPolicy({
      mode: 'frugal',
      warnThreshold: 0.9,
      softThreshold: 0.91,
      hardThreshold: 0.92,
      preserveK: 99,
      eliseThreshold: 99999,
    });
    expect(policy.thresholds.warn).toBe(0.45);
    expect(policy.preserveK).toBe(6);
  });

  it('formats the active mode marker', () => {
    expect(getContextWindowMode('deep')?.name).toBe('Deep');
    expect(formatContextWindowModeList('deep')).toContain('* deep');
  });
});
