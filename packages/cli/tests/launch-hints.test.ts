import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HINT_COUNT, printLaunchHints } from '../src/launch-hints.js';
import { stripAnsi } from '@wrongstack/core';

function makeRenderer(): { write: ReturnType<typeof vi.fn>; output: () => string } {
  const write = vi.fn();
  return {
    write,
    output: () => stripAnsi(write.mock.calls.map((c) => String(c[0])).join('')),
  };
}

describe('printLaunchHints', () => {
  const originalEnv = process.env.WRONGSTACK_NO_HINTS;

  beforeEach(() => {
    delete process.env.WRONGSTACK_NO_HINTS;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WRONGSTACK_NO_HINTS;
    else process.env.WRONGSTACK_NO_HINTS = originalEnv;
  });

  it('exposes at least 20 hints across all groups', () => {
    expect(HINT_COUNT).toBeGreaterThanOrEqual(20);
  });

  it('prints the header with the hint count and key feature mentions', () => {
    const r = makeRenderer();
    printLaunchHints(r, {});
    const out = r.output();
    expect(out).toContain(`WrongStack — ${HINT_COUNT} things you can do here`);
    // Anchor a sample of high-value features from each group
    expect(out).toContain('/goal');
    expect(out).toContain('/autonomy eternal');
    expect(out).toContain('--director');
    expect(out).toContain('/fleet');
    expect(out).toContain('/steer');
    expect(out).toContain('/mode');
    expect(out).toContain('/context mode');
    expect(out).toContain('/mcp');
    expect(out).toContain('/plugin');
    expect(out).toContain('--no-hints');
  });

  it('skips output when --no-hints is set', () => {
    const r = makeRenderer();
    printLaunchHints(r, { 'no-hints': true });
    expect(r.write).not.toHaveBeenCalled();
  });

  it('skips output when WRONGSTACK_NO_HINTS=1 is set', () => {
    process.env.WRONGSTACK_NO_HINTS = '1';
    const r = makeRenderer();
    printLaunchHints(r, {});
    expect(r.write).not.toHaveBeenCalled();
  });

  it('treats WRONGSTACK_NO_HINTS=0 / false as not suppressed', () => {
    process.env.WRONGSTACK_NO_HINTS = '0';
    const r1 = makeRenderer();
    printLaunchHints(r1, {});
    expect(r1.write).toHaveBeenCalled();

    process.env.WRONGSTACK_NO_HINTS = 'false';
    const r2 = makeRenderer();
    printLaunchHints(r2, {});
    expect(r2.write).toHaveBeenCalled();
  });

  it('renders one line per hint plus group headers', () => {
    const r = makeRenderer();
    printLaunchHints(r, {});
    const lines = r.output().split('\n').filter((l) => l.trim().length > 0);
    // Header (1) + group headers (>=5) + hints (HINT_COUNT) + tip footer (1)
    expect(lines.length).toBeGreaterThanOrEqual(HINT_COUNT + 5);
  });
});
