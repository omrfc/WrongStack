import { describe, expect, it, vi } from 'vitest';

const { mkdirMock, mockWpaths } = vi.hoisted(() => ({
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  mockWpaths: {
    globalRoot: '/home/testuser/.wrongstack',
    projectDir: '/tmp/test/.wrongstack',
    projectSessions: '/tmp/test/.wrongstack/sessions',
    globalConfig: '/home/testuser/.wrongstack/config.json',
    projectLocalConfig: '/tmp/test/.wrongstack/config.json',
    secretsKey: '/home/testuser/.wrongstack/.key',
    logFile: '/home/testuser/.wrongstack/wrongstack.log',
    configDir: '/home/testuser/.wrongstack',
    modelsCache: '/home/testuser/.wrongstack/models.json',
    projectTrust: '/tmp/test/.wrongstack/trust.json',
  },
}));

vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }));
vi.mock('node:fs/promises', () => ({ mkdir: mkdirMock }));

vi.mock('@wrongstack/core', () => ({
  DefaultConfigLoader: vi.fn().mockImplementation(function(this: any, opts: any) { this.load = vi.fn().mockResolvedValue({ version: 1, provider: 'anthropic', model: 'claude-sonnet-4-20250514', log: { level: 'info' } }); }),
  DefaultLogger: vi.fn().mockImplementation(function(this: any, opts: { level: string; file?: string }) { this.level = opts.level; this.info = vi.fn(); this.warn = vi.fn(); this.error = vi.fn(); this.child = vi.fn().mockReturnThis(); }),
  DefaultPathResolver: vi.fn().mockImplementation(function(this: any, cwd: string) { this.projectRoot = '/tmp/test'; this.resolve = (p: string) => p; }),
  DefaultSecretVault: vi.fn().mockImplementation(function(this: any, opts: any) { this.encrypt = vi.fn(); this.decrypt = vi.fn(); this.isEncrypted = vi.fn(); }),
  migratePlaintextSecrets: vi.fn().mockResolvedValue({ migrated: 0, file: '' }),
  resolveWstackPaths: vi.fn().mockReturnValue(mockWpaths),
  // The `Encrypted N plaintext secret(s) in FILE` notice in boot.ts
  // routes through `writeErr` after the Phase-5 refactor. The test
  // asserts on process.stderr.write directly, so we forward through
  // to that.
  writeErr: (s: string) => process.stderr.write(s),
}));

import { bootConfig, patchConfig } from '../../src/server/boot.js';

describe('patchConfig', () => {
  it('returns a frozen merge', () => {
    const base = { provider: 'openai', model: 'gpt-5' } as any;
    const result = patchConfig(base, { model: 'gpt-5-mini' });
    expect(result).not.toBe(base);
    expect(result.model).toBe('gpt-5-mini');
    expect(result.provider).toBe('openai');
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('bootConfig', () => {
  it('returns expected shape', async () => {
    const result = await bootConfig();
    expect(result.config.provider).toBe('anthropic');
    expect(result.config.model).toBe('claude-sonnet-4-20250514');
    expect(result.globalConfigPath).toBe('/home/testuser/.wrongstack/config.json');
    expect(result.projectRoot).toBe('/tmp/test');
    expect(result.logger).toBeDefined();
  });

  it('creates required directories', async () => {
    await bootConfig();
    expect(mkdirMock).toHaveBeenCalledWith('/home/testuser/.wrongstack', { recursive: true });
    expect(mkdirMock).toHaveBeenCalledWith('/tmp/test/.wrongstack', { recursive: true });
    expect(mkdirMock).toHaveBeenCalledWith('/tmp/test/.wrongstack/sessions', { recursive: true });
  });

  it('writes a notice to stderr when plaintext secrets get migrated', async () => {
    // Re-import the module after switching the migratePlaintextSecrets mock
    // so the boot run sees the new return shape.
    const core = (await import('@wrongstack/core')) as unknown as {
      migratePlaintextSecrets: ReturnType<typeof vi.fn>;
    };
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // Stub write to capture without printing to test output
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      core.migratePlaintextSecrets
        .mockResolvedValueOnce({ migrated: 2, file: '/path/global.json' })
        .mockResolvedValueOnce({ migrated: 0, file: '' });
      await bootConfig();
      expect(stderrWrites.some((w) => w.includes('Encrypted 2 plaintext'))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
      // Reset the mock back to default for other tests
      core.migratePlaintextSecrets.mockResolvedValue({ migrated: 0, file: '' });
    }
  });

  it('swallows migration errors silently (best-effort)', async () => {
    const core = (await import('@wrongstack/core')) as unknown as {
      migratePlaintextSecrets: ReturnType<typeof vi.fn>;
    };
    core.migratePlaintextSecrets.mockRejectedValueOnce(new Error('vault locked'));
    // Should still resolve, not throw
    await expect(bootConfig()).resolves.toBeDefined();
    core.migratePlaintextSecrets.mockResolvedValue({ migrated: 0, file: '' });
  });
});
