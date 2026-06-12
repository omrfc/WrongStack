import { beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the shared background indexer the command drives.
const { runStartupIndexMock, resetIndexCircuitBreakerMock } = vi.hoisted(() => ({
  runStartupIndexMock: vi.fn(async () => ({
    filesIndexed: 12,
    symbolsIndexed: 345,
    langStats: {},
    durationMs: 7,
    errors: [],
  })),
  resetIndexCircuitBreakerMock: vi.fn(),
}));
vi.mock('@wrongstack/tools', () => ({
  runStartupIndex: runStartupIndexMock,
  resetIndexCircuitBreaker: resetIndexCircuitBreakerMock,
}));

const { buildCodebaseReindexCommand } = await import('../src/slash-commands/codebase-reindex.js');

function build(rendererWrites?: string[]) {
  const renderer = rendererWrites
    ? { write: (s: string) => rendererWrites.push(s) }
    : { write: () => {} };
  return buildCodebaseReindexCommand({ renderer, projectRoot: '/proj' } as never);
}

const ctx = {} as never;

describe('buildCodebaseReindexCommand', () => {
  beforeEach(() => {
    runStartupIndexMock.mockClear();
    resetIndexCircuitBreakerMock.mockClear();
  });

  it('registers under codebase-reindex with a reindex alias', () => {
    const cmd = build();
    expect(cmd.name).toBe('codebase-reindex');
    expect(cmd.aliases).toContain('reindex');
  });

  it('runs an incremental reindex by default', async () => {
    const cmd = build();
    const res = await cmd.run('', ctx);
    expect(runStartupIndexMock).toHaveBeenCalledWith({ projectRoot: '/proj', force: false });
    expect(res?.message).toContain('updated');
    expect(res?.message).toContain('345 symbols');
  });

  it('resets the indexing circuit breaker before running (manual override)', async () => {
    const cmd = build();
    await cmd.run('', ctx);
    expect(resetIndexCircuitBreakerMock).toHaveBeenCalledTimes(1);
    expect(resetIndexCircuitBreakerMock.mock.invocationCallOrder[0]).toBeLessThan(
      runStartupIndexMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('forces a full rebuild when "force" is passed', async () => {
    const cmd = build();
    const res = await cmd.run('force', ctx);
    expect(runStartupIndexMock).toHaveBeenCalledWith({ projectRoot: '/proj', force: true });
    expect(res?.message).toContain('rebuilt');
  });

  it('accepts the --force flag form', async () => {
    const cmd = build();
    await cmd.run('--force', ctx);
    expect(runStartupIndexMock).toHaveBeenCalledWith({ projectRoot: '/proj', force: true });
  });

  it('prints a starting notice before indexing', async () => {
    const writes: string[] = [];
    const cmd = build(writes);
    await cmd.run('', ctx);
    expect(writes.join('')).toMatch(/Reindexing codebase/i);
  });

  it('reports a failure without throwing', async () => {
    runStartupIndexMock.mockRejectedValueOnce(new Error('disk full'));
    const cmd = build();
    const res = await cmd.run('', ctx);
    expect(res?.message).toMatch(/failed/i);
    expect(res?.message).toContain('disk full');
  });
});
