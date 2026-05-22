import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetProcessRegistry,
  getProcessRegistry,
} from '../src/process-registry.js';

type Tracked = {
  pid: number;
  name: string;
  command: string;
  startedAt: number;
  sessionId?: string;
  child: ChildProcess;
};

const fakeChild = (): ChildProcess => {
  const c = {
    killed: false,
    kill: vi.fn(() => {
      c.killed = true;
      return true;
    }),
  };
  return c as unknown as ChildProcess;
};

const makeProc = (overrides: Partial<Tracked> = {}): Tracked => ({
  pid: overrides.pid ?? 1000 + Math.floor(Math.random() * 9000),
  name: overrides.name ?? 'bash',
  command: overrides.command ?? 'echo hi',
  startedAt: overrides.startedAt ?? Date.now(),
  sessionId: overrides.sessionId,
  child: overrides.child ?? fakeChild(),
});

describe('ProcessRegistry', () => {
  beforeEach(() => {
    _resetProcessRegistry();
  });
  afterEach(() => {
    _resetProcessRegistry();
  });

  it('returns the same singleton on repeat access', () => {
    const a = getProcessRegistry();
    const b = getProcessRegistry();
    expect(a).toBe(b);
  });

  it('_resetProcessRegistry creates a fresh instance', () => {
    const a = getProcessRegistry();
    _resetProcessRegistry();
    const b = getProcessRegistry();
    expect(a).not.toBe(b);
  });

  it('register/get/unregister round trip', () => {
    const r = getProcessRegistry();
    const p = makeProc({ pid: 123 });
    r.register(p);
    expect(r.get(123)?.pid).toBe(123);
    expect(r.get(123)?.killed).toBe(false);
    r.unregister(123);
    expect(r.get(123)).toBeUndefined();
  });

  it('list returns all tracked processes', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 1 }));
    r.register(makeProc({ pid: 2 }));
    r.register(makeProc({ pid: 3 }));
    expect(r.list()).toHaveLength(3);
    expect(r.list().map((p) => p.pid).sort()).toEqual([1, 2, 3]);
  });

  it('byName filters by tool name', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 1, name: 'bash' }));
    r.register(makeProc({ pid: 2, name: 'exec' }));
    r.register(makeProc({ pid: 3, name: 'bash' }));
    expect(r.byName('bash')).toHaveLength(2);
    expect(r.byName('exec')).toHaveLength(1);
    expect(r.byName('other')).toHaveLength(0);
  });

  it('bySession filters by sessionId', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 1, sessionId: 's1' }));
    r.register(makeProc({ pid: 2, sessionId: 's2' }));
    r.register(makeProc({ pid: 3, sessionId: 's1' }));
    expect(r.bySession('s1')).toHaveLength(2);
    expect(r.bySession('s2')).toHaveLength(1);
    expect(r.bySession('absent')).toHaveLength(0);
  });

  it('activeCount excludes killed processes', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 1 }));
    r.register(makeProc({ pid: 2 }));
    expect(r.activeCount).toBe(2);
    r.kill(1, { force: true });
    expect(r.activeCount).toBe(1);
  });

  it('stats returns combined counts and breaker snapshot', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 1 }));
    r.register(makeProc({ pid: 2 }));
    const s = r.stats();
    expect(s.activeCount).toBe(2);
    expect(s.totalCount).toBe(2);
    expect(s.breaker).toBeDefined();
    expect(s.breaker.state).toBe('closed');
  });

  it('breaker pass-through: beforeCall is true when closed', () => {
    const r = getProcessRegistry();
    expect(r.beforeCall()).toBe(true);
    expect(r.canProceed).toBe(true);
  });

  it('forceBreakerOpen blocks further calls', () => {
    const r = getProcessRegistry();
    r.forceBreakerOpen();
    expect(r.canProceed).toBe(false);
    expect(r.beforeCall()).toBe(false);
    expect(r.stats().breaker.state).toBe('open');
  });

  it('forceBreakerReset clears the open state', () => {
    const r = getProcessRegistry();
    r.forceBreakerOpen();
    r.forceBreakerReset();
    expect(r.stats().breaker.state).toBe('closed');
    expect(r.canProceed).toBe(true);
  });

  it('afterCall feeds the breaker (consecutive failures trip)', () => {
    const r = getProcessRegistry();
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    expect(r.canProceed).toBe(false);
  });

  it('kill returns false for unknown PID', () => {
    const r = getProcessRegistry();
    expect(r.kill(999)).toBe(false);
  });

  it('kill marks the process killed but keeps it in the registry until unregister', () => {
    const r = getProcessRegistry();
    const proc = makeProc({ pid: 42 });
    r.register(proc);
    expect(r.kill(42, { force: true })).toBe(true);
    expect(r.get(42)?.killed).toBe(true);
    // Process remains in the registry — caller (close handler) unregisters.
    expect(r.list()).toHaveLength(1);
  });

  it('kill twice does not double-send the signal', () => {
    const r = getProcessRegistry();
    const child = fakeChild();
    r.register(makeProc({ pid: 7, child }));
    r.kill(7, { force: true });
    r.kill(7, { force: true });
    // The fake child's .kill should be called at most once (force path).
    expect((child.kill as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('killAll kills every tracked process and returns their PIDs', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 1 }));
    r.register(makeProc({ pid: 2 }));
    r.register(makeProc({ pid: 3 }));
    const killed = r.killAll({ force: true }).sort((a, b) => a - b);
    expect(killed).toEqual([1, 2, 3]);
    expect(r.activeCount).toBe(0);
  });

  it('killSession kills only matching session processes', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 1, sessionId: 's1' }));
    r.register(makeProc({ pid: 2, sessionId: 's2' }));
    r.register(makeProc({ pid: 3, sessionId: 's1' }));
    const killed = r.killSession('s1', { force: true }).sort((a, b) => a - b);
    expect(killed).toEqual([1, 3]);
    expect(r.get(2)?.killed).toBe(false);
  });

  it('killSession returns an empty array when no processes match', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 1, sessionId: 's1' }));
    expect(r.killSession('does-not-exist', { force: true })).toEqual([]);
  });
});
