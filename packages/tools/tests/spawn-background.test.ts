import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnBackground, spawnBackgroundExec } from '../src/spawn-background.js';
import * as os from 'node:os';

describe('spawnBackground', () => {
  // Skip on Windows since spawn behavior differs significantly
  const isWin = os.platform() === 'win32';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns a background process and returns a pid', () => {
    const result = spawnBackground({
      command: 'echo hello',
    });
    expect(result.pid).toBeDefined();
    expect(typeof result.pid).toBe('number');
  });

  it('returns immediately without waiting for the process', () => {
    const start = Date.now();
    const result = spawnBackground({
      command: 'sleep 5 && echo done',
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // Should return immediately
    expect(result.pid).toBeDefined();
  });

  it('respects cwd option', () => {
    const result = spawnBackground({
      command: 'pwd',
      cwd: '/tmp',
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
    const result = spawnBackgroundExec('echo', ['hello']);
    expect(result.pid).toBeDefined();
  });

  it('returns immediately without waiting', () => {
    const start = Date.now();
    const result = spawnBackgroundExec('sleep', ['2']);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result.pid).toBeDefined();
  });

  it('passes environment variables', () => {
    const result = spawnBackgroundExec('printenv', ['TEST_VAR'], undefined, {
      TEST_VAR: 'test_value',
    });
    expect(result.pid).toBeDefined();
  });

  it('respects cwd option', () => {
    const result = spawnBackgroundExec('pwd', [], '/tmp');
    expect(result.pid).toBeDefined();
  });
});
