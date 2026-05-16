import { describe, expect, it } from 'vitest';

describe('@wrongstack/tui module', () => {
  it('exports runTui as a function', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.runTui).toBe('function');
  }, 15_000);
});
