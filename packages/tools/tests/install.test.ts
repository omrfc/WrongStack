import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { installTool } from '../src/install.js';
import * as Core from '@wrongstack/core';
import type { SpawnStreamResult } from '../src/_spawn-stream.js';
import type { ToolProgressEvent } from '@wrongstack/core';

// Mock spawnStream — an AsyncGenerator<ToolProgressEvent, SpawnStreamResult>.
// executeStream calls: const result = yield* spawnStream({...})
vi.mock('../src/_spawn-stream.js', () => ({
  spawnStream: (async function * (): AsyncGenerator<ToolProgressEvent, SpawnStreamResult> {
    yield { type: 'partial_output', text: 'added 1 package\n' };
    return {
      stdout: 'added 1 package',
      stderr: '',
      exitCode: 0,
      truncated: false,
    };
  }) as never as () => AsyncGenerator<ToolProgressEvent, SpawnStreamResult>,
}));

const makeCtx = (overrides?: Record<string, unknown>) =>
  ({
    cwd: '/fake',
    tools: [],
    projectRoot: '/fake',
    agentId: 'leader',
    agentName: 'Leader',
    ...overrides,
  }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('installTool', () => {
  beforeEach(() => {
    vi.spyOn(Core, 'recordPackageAction').mockResolvedValue(undefined);
    vi.spyOn(Core, 'detectPackageEcosystem').mockReturnValue('npm');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct metadata', () => {
    expect(installTool.name).toBe('install');
    expect(installTool.permission).toBe('confirm');
    expect(installTool.mutating).toBe(true);
    expect(installTool.riskTier).toBe('standard');
  });

  it('handles empty packages', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({}, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('packages');
  });

  it('passes single package', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  it('passes multiple packages as comma string', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'vitest,prettier' }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  it('passes packages as array', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: ['vitest', 'prettier'] }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  it('passes save=dev flag', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', save: 'dev' }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('passes global flag', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', global: true }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('respects dry_run', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', dry_run: true }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  // ── Authorship tracking ────────────────────────────────────────────────────

  it('records package authorship when ctx.meta.packageTrackerOpts is set', async () => {
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(Core.recordPackageAction).toHaveBeenCalledWith(
      { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      expect.objectContaining({
        packageName: 'vitest',
        agentId: 'leader',
        agentName: 'Leader',
        sessionId: 'sess-abc',
        ecosystem: 'npm',
      }),
    );
  });

  it('records multiple packages in one install', async () => {
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    await installTool.execute({ packages: ['vitest', 'prettier'] }, ctx, makeOpts());
    expect(Core.recordPackageAction).toHaveBeenCalledTimes(2);
    expect(Core.recordPackageAction).toHaveBeenNthCalledWith(
      1,
      { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      expect.objectContaining({ packageName: 'vitest' }),
    );
    expect(Core.recordPackageAction).toHaveBeenNthCalledWith(
      2,
      { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      expect.objectContaining({ packageName: 'prettier' }),
    );
  });

  it('does NOT record authorship when ctx.meta.packageTrackerOpts is absent', async () => {
    const ctx = makeCtx({ meta: {} });
    await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(Core.recordPackageAction).not.toHaveBeenCalled();
  });

  it('does NOT record authorship for global installs', async () => {
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    await installTool.execute({ packages: 'vitest', global: true }, ctx, makeOpts());
    expect(Core.recordPackageAction).not.toHaveBeenCalled();
  });

  it('does NOT record authorship for dry_run installs', async () => {
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    await installTool.execute({ packages: 'vitest', dry_run: true }, ctx, makeOpts());
    expect(Core.recordPackageAction).not.toHaveBeenCalled();
  });

  it('resolves an explicit cwd', async () => {
    const result = await installTool.execute({ packages: 'foo', cwd: '.' }, makeCtx(), makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('throws when executeStream is unavailable', async () => {
    const original = installTool.executeStream;
    installTool.executeStream = undefined;
    try {
      await expect(installTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      installTool.executeStream = original;
    }
  });

  it('throws when the stream ends without a final event', async () => {
    const original = installTool.executeStream!;
    installTool.executeStream = async function* () {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(installTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      installTool.executeStream = original;
    }
  });

  it('rejects an invalid package name (flag injection guard)', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: '--ignore-scripts' }, ctx, makeOpts());
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain('Invalid package name');
  });

  it('builds pnpm add args with a save flag', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-pnpm-'));
    try {
      await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
      const ctx = makeCtx({ cwd: dir, projectRoot: dir });
      const result = await installTool.execute({ packages: 'foo', save: 'dev' }, ctx, makeOpts());
      expect(result).toHaveProperty('exit_code');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('passes save=optional flag', async () => {
    const result = await installTool.execute(
      { packages: 'foo', save: 'optional' },
      makeCtx(),
      makeOpts(),
    );
    expect(result).toHaveProperty('exit_code');
  });

  it('builds yarn add args', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-yarn-'));
    try {
      await fs.writeFile(path.join(dir, 'yarn.lock'), '');
      const ctx = makeCtx({ cwd: dir, projectRoot: dir });
      const result = await installTool.execute({ packages: 'foo' }, ctx, makeOpts());
      expect(result).toHaveProperty('exit_code');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT throw when recordPackageAction fails (best-effort)', async () => {
    vi.mocked(Core.recordPackageAction).mockRejectedValueOnce(new Error('disk full'));
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    const result = await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
    expect(Core.recordPackageAction).toHaveBeenCalled();
  });
});
