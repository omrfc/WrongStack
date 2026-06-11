import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnBackground, spawnBackgroundExec } from '../src/spawn-background.js';
import * as os from 'node:os';

describe('spawnBackground', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns a background process and returns a pid', () => {
    const result = spawnBackground({
      command: 'node --version',
    });
    expect(result.pid).toBeDefined();
    expect(typeof result.pid).toBe('number');
  });

  it('returns immediately without waiting for the process', () => {
    const start = Date.now();
    const result = spawnBackground({
      command: 'node -e "setTimeout(() => {}, 5000)"',
    });
    const elapsed = Date.now() - start;
    // Proves we don't block on the 5s child. Anything well under the child's
    // sleep counts as "immediate" — a tight bound (100ms) flakes when spawn
    // itself is slow under full-suite load.
    expect(elapsed).toBeLessThan(2000);
    expect(result.pid).toBeDefined();
  });

  it('respects cwd option', () => {
    const result = spawnBackground({
      command: 'node --version',
      cwd: os.tmpdir(),
    });
    expect(result.pid).toBeDefined();
  });

  it('handles commands with arguments', () => {
    const result = spawnBackground({
      command: 'node --version',
    });
    expect(result.pid).toBeDefined();
  });
});

describe('spawnBackgroundExec', () => {
  it('spawns a process without shell wrapping', () => {
    const result = spawnBackgroundExec('node', ['--version']);
    expect(result.pid).toBeDefined();
  });

  it('returns immediately without waiting', () => {
    const start = Date.now();
    const result = spawnBackgroundExec('node', ['-e', 'setTimeout(() => {}, 2000)']);
    const elapsed = Date.now() - start;
    // Same rationale as above: must beat the child's 2s sleep, not 100ms.
    expect(elapsed).toBeLessThan(1500);
    expect(result.pid).toBeDefined();
  });

  it('passes environment variables', () => {
    const result = spawnBackgroundExec('node', ['-e', 'process.env.TEST_VAR'], undefined, {
      TEST_VAR: 'test_value',
    });
    expect(result.pid).toBeDefined();
  });

  it('respects cwd option', () => {
    const result = spawnBackgroundExec('node', ['-e', ''], os.tmpdir());
    expect(result.pid).toBeDefined();
  });

  it('does not crash the host process when the command does not exist', async () => {
    const { child } = spawnBackgroundExec('definitely-not-a-real-command-xyz', []);
    // The default error handler must swallow the async ENOENT; give it a tick to fire.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.pid ?? null).toBeNull();
  });
});
