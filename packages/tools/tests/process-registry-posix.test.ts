import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force the POSIX kill path (process-group signals) on any host.
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, default: actual, platform: () => 'linux' as NodeJS.Platform };
});

import { _resetProcessRegistry, getProcessRegistry } from '../src/process-registry.js';

const fakeChild = (): ChildProcess => {
  const c = { killed: false, kill: vi.fn(() => { c.killed = true; return true; }) };
  return c as never as ChildProcess;
};
const makeProc = (pid: number) => ({
  pid,
  name: 'bash',
  command: 'sleep 1',
  startedAt: Date.now(),
  child: fakeChild(),
});

beforeEach(() => _resetProcessRegistry());
afterEach(() => {
  _resetProcessRegistry();
  vi.restoreAllMocks();
});

describe('ProcessRegistry POSIX kill', () => {
  it('force-kills via the process group (falls back to child.kill)', () => {
    const r = getProcessRegistry();
    const proc = makeProc(987654); // pid that process.kill(-pid) cannot signal
    r.register(proc);
    expect(r.kill(proc.pid, { force: true })).toBe(true);
    // process.kill(-pid) throws ESRCH for the bogus pid → child.kill('SIGKILL').
    expect((proc.child.kill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('SIGKILL');
    expect(r.get(proc.pid)?.killed).toBe(true);
  });

  it('non-force: falls back to child.kill when the group SIGTERM throws', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    try {
      const r = getProcessRegistry();
      const proc = makeProc(987658);
      r.register(proc);
      expect(r.kill(proc.pid)).toBe(true);
      // process.kill(-pid,'SIGTERM') threw → child.kill('SIGTERM') fallback.
      expect(proc.child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('non-force backup: falls back to child.kill when the group SIGKILL throws', () => {
    // SIGTERM succeeds (child stays "alive"), so the backup timer runs; the
    // group SIGKILL then throws → nested child.kill('SIGKILL') fallback.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 'SIGKILL') throw new Error('ESRCH');
      return true;
    });
    vi.useFakeTimers();
    try {
      const r = getProcessRegistry();
      const proc = makeProc(987659);
      r.register(proc);
      expect(r.kill(proc.pid, { graceMs: 50 })).toBe(true);
      vi.advanceTimersByTime(60); // backup timer fires → SIGKILL throws → child.kill
      expect(proc.child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });

  it('SIGTERM then schedules a SIGKILL backup (non-force)', () => {
    // Make the process-group signal "succeed" so child.killed stays false and
    // the backup SIGKILL timer actually escalates via process.kill(-pid).
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const r = getProcessRegistry();
      const proc = makeProc(987655);
      r.register(proc);
      expect(r.kill(proc.pid, { graceMs: 50 })).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGTERM');
      vi.advanceTimersByTime(60); // backup timer fires
      expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGKILL');
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });
});
