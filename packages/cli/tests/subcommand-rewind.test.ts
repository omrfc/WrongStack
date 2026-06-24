import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the core's rewinder/store classes — exercised in their own tests.
// Use vi.hoisted so the mock factory can refer to the shared instances.
const mocks = vi.hoisted(() => ({
  rewindInstance: {
    listCheckpoints: vi.fn(),
    rewindToStart: vi.fn(),
    rewindLastN: vi.fn(),
    rewindToCheckpoint: vi.fn(),
  },
  storeInstance: {
    resume: vi.fn(),
  },
}));
const { rewindInstance, storeInstance } = mocks;

vi.mock('@wrongstack/core', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class FakeRewinder {
    listCheckpoints = mocks.rewindInstance.listCheckpoints;
    rewindToStart = mocks.rewindInstance.rewindToStart;
    rewindLastN = mocks.rewindInstance.rewindLastN;
    rewindToCheckpoint = mocks.rewindInstance.rewindToCheckpoint;
  }
  class FakeStore {
    resume = mocks.storeInstance.resume;
  }
  return {
    ...actual,
    DefaultSessionRewinder: FakeRewinder,
    DefaultSessionStore: FakeStore,
  };
});

import { rewindCmd } from '../src/subcommands/handlers/rewind.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

function fakeDeps(overrides: Partial<SubcommandDeps> = {}): SubcommandDeps {
  return {
    config: {} as SubcommandDeps['config'],
    renderer: { write: vi.fn(), writeError: vi.fn() } as unknown as SubcommandDeps['renderer'],
    reader: {} as SubcommandDeps['reader'],
    sessionStore: {
      list: vi.fn().mockResolvedValue([{ id: 'auto-session-1' }]),
    } as unknown as NonNullable<SubcommandDeps['sessionStore']>,
    skillLoader: undefined,
    toolRegistry: undefined,
    modelsRegistry: {} as SubcommandDeps['modelsRegistry'],
    paths: {} as SubcommandDeps['paths'],
    vault: {} as SubcommandDeps['vault'],
    cwd: '/tmp/proj',
    projectRoot: '/tmp/proj',
    userHome: '/tmp',
    flags: {},
    ...overrides,
  };
}

beforeEach(() => {
  rewindInstance.listCheckpoints.mockReset();
  rewindInstance.rewindToStart.mockReset();
  rewindInstance.rewindLastN.mockReset();
  rewindInstance.rewindToCheckpoint.mockReset();
  storeInstance.resume.mockReset();
});

describe('rewindCmd', () => {
  it('errors when no sessions available and no id passed', async () => {
    const deps = fakeDeps({
      sessionStore: {
        create: vi.fn(),
        load: vi.fn(),
        resume: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
        clearHistory: vi.fn(),
        prune: vi.fn(),
      } as unknown as NonNullable<SubcommandDeps['sessionStore']>,
    });
    const code = await rewindCmd([], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('No sessions found.');
  });

  it('errors when sessionStore unavailable and no id passed', async () => {
    const deps = fakeDeps({ sessionStore: undefined });
    const code = await rewindCmd([], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('No session store available.');
  });

  it('--list with no checkpoints prints empty message', async () => {
    rewindInstance.listCheckpoints.mockResolvedValue([]);
    const deps = fakeDeps();
    const code = await rewindCmd(['--list'], deps);
    expect(code).toBe(0);
    const calls = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(calls).toContain('No checkpoints');
  });

  it('--list renders checkpoint table with file counts', async () => {
    rewindInstance.listCheckpoints.mockResolvedValue([
      { promptIndex: 0, ts: '2026-01-01', promptPreview: 'first', fileCount: 0 },
      { promptIndex: 1, ts: '2026-01-02', promptPreview: 'second', fileCount: 3 },
      { promptIndex: 2, ts: '2026-01-03', promptPreview: 'third', fileCount: 1 },
    ]);
    const deps = fakeDeps();
    await rewindCmd(['my-session', '--list'], deps);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('first');
    expect(all).toContain('3 files');
    expect(all).toContain('1 file');
  });

  it('shows usage when no action flag passed', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd([], deps);
    expect(code).toBe(1);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('Usage:');
  });

  it('--all calls rewindToStart and reports no-files when empty', async () => {
    rewindInstance.rewindToStart.mockResolvedValue({
      revertedFiles: [],
      errors: [],
      toPromptIndex: 0,
    });
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(0);
    expect(rewindInstance.rewindToStart).toHaveBeenCalledWith('auto-session-1');
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('No files to revert');
  });

  it('--all reports reverted files with checkmarks', async () => {
    rewindInstance.rewindToStart.mockResolvedValue({
      revertedFiles: ['src/a.ts', 'src/b.ts'],
      errors: [],
      toPromptIndex: 0,
    });
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(0);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('src/a.ts');
    expect(all).toContain('src/b.ts');
    expect(all).toContain('Reverted 2 file');
  });

  it('--last N rewinds last N', async () => {
    rewindInstance.rewindLastN.mockResolvedValue({
      revertedFiles: ['src/foo.ts'],
      errors: [],
      toPromptIndex: 1,
    });
    const deps = fakeDeps();
    await rewindCmd(['--last', '2'], deps);
    expect(rewindInstance.rewindLastN).toHaveBeenCalledWith('auto-session-1', 2);
  });

  it('--last with invalid N reports usage', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd(['--last', 'abc'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('--last requires a positive number');
  });

  it('--last with 0 reports usage', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd(['--last', '0'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('--last requires a positive number');
  });

  it('--to <idx> calls rewindToCheckpoint', async () => {
    rewindInstance.rewindToCheckpoint.mockResolvedValue({
      revertedFiles: ['x.ts'],
      errors: [],
      toPromptIndex: 3,
    });
    const deps = fakeDeps();
    await rewindCmd(['--to', '3'], deps);
    expect(rewindInstance.rewindToCheckpoint).toHaveBeenCalledWith('auto-session-1', 3);
  });

  it('--to invalid number reports usage', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd(['--to', 'bad'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('--to requires a non-negative number');
  });

  it('--to negative reports usage', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd(['--to', '-1'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('--to requires a non-negative number');
  });

  it('--resume after rewind truncates session history', async () => {
    rewindInstance.rewindLastN.mockResolvedValue({
      revertedFiles: ['x.ts'],
      errors: [],
      toPromptIndex: 5,
    });
    const truncate = vi.fn().mockResolvedValue(3);
    const close = vi.fn().mockResolvedValue(undefined);
    storeInstance.resume.mockResolvedValue({
      writer: { truncateToCheckpoint: truncate, close },
    });
    const deps = fakeDeps();
    await rewindCmd(['--last', '1', '--resume'], deps);
    expect(truncate).toHaveBeenCalledWith(5);
    expect(close).toHaveBeenCalled();
  });

  it('--resume with no reverted files still truncates', async () => {
    rewindInstance.rewindToStart.mockResolvedValue({
      revertedFiles: [],
      errors: [],
      toPromptIndex: 0,
    });
    const truncate = vi.fn().mockResolvedValue(0);
    const close = vi.fn().mockResolvedValue(undefined);
    storeInstance.resume.mockResolvedValue({
      writer: { truncateToCheckpoint: truncate, close },
    });
    const deps = fakeDeps();
    const code = await rewindCmd(['--all', '--resume'], deps);
    expect(code).toBe(0);
    expect(truncate).toHaveBeenCalledWith(0);
  });

  it('returns 1 when rewind produces errors', async () => {
    rewindInstance.rewindToStart.mockResolvedValue({
      revertedFiles: ['x.ts'],
      errors: ['perm denied'],
      toPromptIndex: 0,
    });
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(1);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('perm denied');
  });

  it('catches and reports thrown errors', async () => {
    rewindInstance.rewindToStart.mockRejectedValue(new Error('disk full'));
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('disk full');
  });

  it('handles non-Error thrown values', async () => {
    rewindInstance.rewindToStart.mockRejectedValue('string error');
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('string error');
  });
});
