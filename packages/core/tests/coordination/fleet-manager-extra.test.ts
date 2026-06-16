import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetManager } from '../../src/coordination/fleet-manager.js';
import type { SubagentConfig } from '../../src/types/multi-agent.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-mgr-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (over: Partial<SubagentConfig> = {}): SubagentConfig => ({ name: 'W', role: 'coder', provider: 'anthropic', model: 'm', ...over }) as SubagentConfig;

describe('FleetManager accessors + pending tasks', () => {
  it('exposes usedNicknames and assigns memorable nicknames', () => {
    const fm = new FleetManager();
    expect(fm.usedNicknames.size).toBe(0);
    const c = cfg({ name: undefined as never });
    fm.assignNicknameAndRecord(c);
    expect(fm.usedNicknames.size).toBe(1);
    expect(typeof c.name).toBe('string'); // nickname written back
  });

  it('tracks pending tasks and surfaces them via getFleetStatus', () => {
    const fm = new FleetManager();
    fm.addPendingTask('t1', 's1', 'do the thing');
    fm.addPendingTask('t2', 's2', 'other');
    const status = fm.getFleetStatus();
    expect(status.pending).toEqual(expect.arrayContaining([
      { taskId: 't1', description: 'do the thing', subagentId: 's1' },
    ]));
    expect(status.live).toEqual([]);
    fm.removePendingTask('t1');
    expect(fm.getFleetStatus().pending.map((p) => p.taskId)).toEqual(['t2']);
  });
});

describe('FleetManager.getFleetStats', () => {
  it('returns zeros with no coordinator', () => {
    expect(new FleetManager().getFleetStats()).toMatchObject({ total: 0, running: 0, subagentStatuses: [] });
  });

  it('delegates to the coordinator and maps subagent statuses', () => {
    const fm = new FleetManager();
    const coordinator = {
      getStats: () => ({ total: 2, running: 1, idle: 1, stopped: 0, inFlight: 1, pending: 0, completed: 1 }),
      subagents: new Map([
        ['s1', { currentTask: 't1', status: 'running', context: { parentBridge: {} } }],
        ['s2', { currentTask: undefined, status: 'idle', context: { parentBridge: null } }],
      ]),
    };
    fm.setCoordinator(coordinator as never);
    const stats = fm.getFleetStats();
    expect(stats.total).toBe(2);
    expect(stats.subagentStatuses).toHaveLength(2);
    expect(stats.subagentStatuses.find((s) => s.subagentId === 's1')).toMatchObject({ taskId: 't1', status: 'running', assigned: true });
    expect(stats.subagentStatuses.find((s) => s.subagentId === 's2')).toMatchObject({ taskId: '', assigned: false });
  });
});

describe('FleetManager.removeSubagent', () => {
  it('frees the nickname slot and drops the subagent pending tasks', () => {
    const fm = new FleetManager();
    const c = cfg({ name: undefined as never });
    fm.assignNicknameAndRecord(c); // nickname → c.name + usedNicknames
    fm.recordSpawn('sub-1', c); // manifest entry keyed by sub-1 with c.name
    fm.addPendingTask('t1', 'sub-1', 'x');
    fm.addPendingTask('t2', 'other', 'y');
    expect(fm.usedNicknames.size).toBe(1);

    fm.removeSubagent('sub-1');
    expect(fm.usedNicknames.size).toBe(0); // freed
    expect(fm.getFleetStatus().pending.map((p) => p.taskId)).toEqual(['t2']); // sub-1's pending dropped
  });
});

describe('FleetManager manifest scheduling + dispose', () => {
  it('writes synchronously when debounce is 0', async () => {
    const manifestPath = path.join(tmp, 'm0.json');
    const fm = new FleetManager({ manifestPath, manifestDebounceMs: 0 });
    fm.recordSpawn('s1', cfg());
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).children).toHaveLength(1));
    fm.dispose();
  });

  it('writes via the debounce timer when debounce > 0', async () => {
    const manifestPath = path.join(tmp, 'm1.json');
    const fm = new FleetManager({ manifestPath, manifestDebounceMs: 5 });
    fm.recordSpawn('s1', cfg());
    fm.recordSpawn('s2', cfg({ name: 'W2' })); // second spawn coalesces into the same timer
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).children.length).toBeGreaterThanOrEqual(1));
    fm.dispose();
  });

  it('flushManifest clears the pending timer and writes immediately', async () => {
    const manifestPath = path.join(tmp, 'm2.json');
    const fm = new FleetManager({ manifestPath, manifestDebounceMs: 5000 });
    fm.recordSpawn('s1', cfg()); // arms a 5s timer
    await fm.flushManifest();
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).children).toHaveLength(1);
    fm.dispose(); // timer already cleared → exercises the no-timer branch
  });

  it('flushManifest and writeManifest no-op without a manifest path', async () => {
    const fm = new FleetManager();
    await expect(fm.flushManifest()).resolves.toBeUndefined();
    expect(await fm.writeManifest()).toBeNull();
  });

  it('dispose clears an armed debounce timer', () => {
    const fm = new FleetManager({ manifestPath: path.join(tmp, 'm3.json'), manifestDebounceMs: 5000 });
    fm.recordSpawn('s1', cfg()); // arms the timer
    expect(() => fm.dispose()).not.toThrow();
  });

  it('disables manifest writes when debounce is negative', async () => {
    const manifestPath = path.join(tmp, 'neg.json');
    const fm = new FleetManager({ manifestPath, manifestDebounceMs: -1 });
    fm.recordSpawn('s1', cfg());
    await expect(fs.readFile(manifestPath, 'utf8')).rejects.toThrow(); // never written
    fm.dispose();
  });

  it('swallows a failing session-writer append', () => {
    const sessionWriter = { append: vi.fn().mockRejectedValue(new Error('writer closed')) };
    const fm = new FleetManager({ sessionWriter: sessionWriter as never });
    expect(() => fm.recordSpawn('s1', cfg())).not.toThrow();
  });

  it('warns instead of throwing when a manifest write fails (sync, timer, flush)', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    // A FILE where the manifest parent dir should be → mkdir/atomicWrite fail.
    await fs.writeFile(path.join(tmp, 'blocker'), 'x');
    const bad = path.join(tmp, 'blocker', 'm.json');

    const sync = new FleetManager({ manifestPath: bad, manifestDebounceMs: 0 });
    sync.recordSpawn('s1', cfg());

    const timer = new FleetManager({ manifestPath: bad, manifestDebounceMs: 5 });
    timer.recordSpawn('s1', cfg());

    const flush = new FleetManager({ manifestPath: bad, manifestDebounceMs: 5000 });
    flush.recordSpawn('s1', cfg());
    await flush.flushManifest();

    // Wait for all three failure warnings (sync + timer + flush) before disposing,
    // otherwise dispose() would clear the 5ms timer before its catch handler runs.
    await vi.waitFor(() => expect(warn.mock.calls.length).toBeGreaterThanOrEqual(3));
    sync.dispose();
    timer.dispose();
    flush.dispose();
  });
});

describe('FleetManager with a state checkpoint', () => {
  it('records spawns into the checkpoint', async () => {
    const fm = new FleetManager({ stateCheckpointPath: path.join(tmp, 'ckpt.json') });
    expect(() => fm.recordSpawn('s1', cfg())).not.toThrow();
    fm.dispose();
  });
});
