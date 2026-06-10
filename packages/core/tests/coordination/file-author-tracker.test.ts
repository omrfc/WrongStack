import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  recordFileAction,
  getLastAuthor,
  getFileHistory,
  getFilesByAgent,
  getFullLog,
  compactLog,
  type FileAuthorTrackerOptions,
} from '../../src/coordination/file-author-tracker.js';

describe('file-author-tracker', () => {
  let tmpDir: string;
  let opts: FileAuthorTrackerOptions;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fat-test-'));
    opts = { storageDir: tmpDir, projectRoot: '/fake/project' };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('records a create action and retrieves it', async () => {
    await recordFileAction(opts, {
      filePath: 'src/index.ts',
      action: 'create',
      agentId: 'leader',
      agentName: 'Leader',
    });

    const last = await getLastAuthor(opts, 'src/index.ts');
    expect(last).toBeDefined();
    expect(last!.action).toBe('create');
    expect(last!.agentId).toBe('leader');
    expect(last!.filePath).toBe('src/index.ts');
  });

  it('records multiple actions and returns the latest', async () => {
    await recordFileAction(opts, {
      filePath: 'src/index.ts',
      action: 'create',
      agentId: 'leader',
    });
    await recordFileAction(opts, {
      filePath: 'src/index.ts',
      action: 'edit',
      agentId: 'tech-stack',
    });

    const last = await getLastAuthor(opts, 'src/index.ts');
    expect(last!.action).toBe('edit');
    expect(last!.agentId).toBe('tech-stack');
  });

  it('returns file history in order', async () => {
    await recordFileAction(opts, { filePath: 'a.ts', action: 'create', agentId: 'x' });
    await recordFileAction(opts, { filePath: 'a.ts', action: 'edit', agentId: 'y' });
    await recordFileAction(opts, { filePath: 'a.ts', action: 'edit', agentId: 'z' });

    const history = await getFileHistory(opts, 'a.ts');
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.agentId)).toEqual(['x', 'y', 'z']);
  });

  it('getFilesByAgent returns latest per file', async () => {
    await recordFileAction(opts, { filePath: 'a.ts', action: 'create', agentId: 'leader' });
    await recordFileAction(opts, { filePath: 'b.ts', action: 'create', agentId: 'leader' });
    await recordFileAction(opts, { filePath: 'a.ts', action: 'edit', agentId: 'tech-stack' });

    const map = await getFilesByAgent(opts, 'leader');
    // leader created a.ts and b.ts; tech-stack later edited a.ts
    // so leader's latest touch on a.ts is the create, b.ts is the create
    expect(map.size).toBe(2);
    expect(map.has('a.ts')).toBe(true); // leader's create
    expect(map.has('b.ts')).toBe(true); // leader's create
    expect(map.get('a.ts')!.action).toBe('create');
  });

  it('compacts log and archives old entries', async () => {
    for (let i = 0; i < 10; i++) {
      await recordFileAction(opts, { filePath: `f${i}.ts`, action: 'create', agentId: 'x' });
    }

    const result = await compactLog(opts, 5);
    expect(result.archived).toBe(5);
    expect(result.kept).toBe(5);

    const log = await getFullLog(opts);
    expect(log.entries).toHaveLength(5);
    expect(log.lastCompactedAt).toBeDefined();
  });

  it('handles windows-style paths', async () => {
    await recordFileAction(opts, {
      filePath: 'src\\index.ts',
      action: 'create',
      agentId: 'leader',
    });

    const last = await getLastAuthor(opts, 'src/index.ts');
    expect(last).toBeDefined();
  });
});
