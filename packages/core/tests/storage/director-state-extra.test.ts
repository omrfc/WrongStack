import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorStateCheckpoint, loadDirectorState } from '../../src/storage/director-state.js';

// Covers the load-missing-file branch, the recordTaskAssigned update branch,
// the natural debounce-timer fire, the persist failure warning, and the
// persist writing-guard that the main director-state.test.ts does not reach.

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-extra-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('director-state — extra coverage', () => {
  it('loadDirectorState returns null when the file does not exist', async () => {
    expect(await loadDirectorState(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('recordTaskAssigned updates an existing task in place', async () => {
    const file = path.join(dir, 's.json');
    const cp = new DirectorStateCheckpoint(file, { directorRunId: 'r', spawnDepth: 0, maxSpawnDepth: 2 }, 10);
    cp.recordTaskAssigned({ taskId: 't1', subagentId: 'a', description: 'first', status: 'running' });
    cp.recordTaskAssigned({ taskId: 't1', subagentId: 'b', description: 'second', status: 'running' });
    await cp.flush();
    const loaded = await loadDirectorState(file);
    expect(loaded?.tasks).toHaveLength(1);
    expect(loaded?.tasks[0]?.subagentId).toBe('b');
  });

  it('persists via the debounce timer without an explicit flush', async () => {
    const file = path.join(dir, 'timer.json');
    const cp = new DirectorStateCheckpoint(file, { directorRunId: 'r', spawnDepth: 0, maxSpawnDepth: 2 }, 10);
    cp.recordSpawn({ id: 's1', spawnedAt: new Date().toISOString() }, 1);
    await vi.waitFor(async () => {
      const loaded = await loadDirectorState(file);
      expect(loaded?.spawnCount).toBe(1);
    }, { timeout: 2000 });
  });

  it('warns but does not throw when persist cannot write the checkpoint', async () => {
    const fileAsDir = path.join(dir, 'asdir.json');
    await fs.mkdir(fileAsDir, { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cp = new DirectorStateCheckpoint(fileAsDir, { directorRunId: 'r', spawnDepth: 0, maxSpawnDepth: 2 }, 10);
    cp.recordSpawn({ id: 's1', spawnedAt: new Date().toISOString() }, 1);
    await cp.flush();
    expect(warn).toHaveBeenCalled();
  });

  it('persist defers to a follow-up write when one is already in flight', async () => {
    const file = path.join(dir, 'guard.json');
    const cp = new DirectorStateCheckpoint(file, { directorRunId: 'r', spawnDepth: 0, maxSpawnDepth: 2 }, 10);
    (cp as unknown as { writing: boolean }).writing = true;
    await (cp as unknown as { persist(): Promise<void> }).persist();
    expect((cp as unknown as { rewriteRequested: boolean }).rewriteRequested).toBe(true);
  });
});
