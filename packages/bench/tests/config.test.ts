import { describe, expect, it } from 'vitest';
import { parseBenchConfig } from '../src/config.js';

describe('parseBenchConfig', () => {
  it('parses a minimal valid config and applies defaults', () => {
    const cfg = parseBenchConfig({
      cells: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
    });
    expect(cfg.cells).toHaveLength(1);
    expect(cfg.cells[0]?.label).toBe('anthropic/claude-opus-4-8');
    expect(cfg.maxIterations).toBe(40);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.timeoutMs).toBe(600_000);
  });

  it('honors explicit labels and limits', () => {
    const cfg = parseBenchConfig({
      maxIterations: 20,
      concurrency: 2,
      timeoutMs: 120_000,
      cells: [{ label: 'opus', provider: 'anthropic', model: 'claude-opus-4-8' }],
    });
    expect(cfg.cells[0]?.label).toBe('opus');
    expect(cfg.maxIterations).toBe(20);
    expect(cfg.concurrency).toBe(2);
    expect(cfg.timeoutMs).toBe(120_000);
  });

  it('rejects an empty cell list', () => {
    expect(() => parseBenchConfig({ cells: [] })).toThrow(/non-empty array/);
  });

  it('rejects duplicate labels', () => {
    expect(() =>
      parseBenchConfig({
        cells: [
          { label: 'x', provider: 'a', model: 'm1' },
          { label: 'x', provider: 'b', model: 'm2' },
        ],
      }),
    ).toThrow(/duplicate cell label/);
  });

  it('rejects a cell missing provider or model', () => {
    expect(() => parseBenchConfig({ cells: [{ provider: 'a' }] })).toThrow(/model/);
    expect(() => parseBenchConfig({ cells: [{ model: 'm' }] })).toThrow(/provider/);
  });

  it('rejects non-positive numeric fields', () => {
    expect(() =>
      parseBenchConfig({ maxIterations: 0, cells: [{ provider: 'a', model: 'm' }] }),
    ).toThrow(/maxIterations/);
  });
});
