import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `bootConfig` is the single canonical boot routine shared by the CLI and the
 * WebUI server (packages/cli/src/boot-config.ts and
 * packages/webui/src/server/boot.ts are thin wrappers). These tests pin the
 * behaviors that used to live in the per-package boot tests — directory
 * creation, the plaintext-secret migration notice, and best-effort migration
 * failure — against the canonical implementation so the two consumers can't
 * drift. End-to-end shape/flag/sync coverage lives in the CLI's
 * boot-config.test.ts (which runs the real core against a temp HOME).
 */

const { mkdirMock, writeFileMock, mockWpaths } = vi.hoisted(() => ({
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  mockWpaths: {
    globalRoot: '/home/testuser/.wrongstack',
    projectDir: '/tmp/test/.wrongstack',
    projectSessions: '/tmp/test/.wrongstack/sessions',
    projectMeta: '/tmp/test/.wrongstack/meta.json',
    projectHash: 'abc123',
    globalConfig: '/home/testuser/.wrongstack/config.json',
    projectLocalConfig: '/tmp/test/.wrongstack/config.json',
    secretsKey: '/home/testuser/.wrongstack/.key',
    logFile: '/home/testuser/.wrongstack/wrongstack.log',
  },
}));

vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }));
vi.mock('node:fs/promises', () => ({ mkdir: mkdirMock, writeFile: writeFileMock }));

vi.mock('../src/storage/config-loader.js', () => ({
  DefaultConfigLoader: vi.fn().mockImplementation(function (this: any) {
    this.load = vi
      .fn()
      .mockResolvedValue({
        version: 1,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        log: { level: 'info' },
      });
    this.loadSyncConfig = vi.fn().mockResolvedValue(null);
  }),
}));
vi.mock('../src/infrastructure/logger.js', () => ({
  DefaultLogger: vi.fn().mockImplementation(function (this: any, opts: { level: string }) {
    this.level = opts?.level;
  }),
}));
vi.mock('../src/infrastructure/path-resolver.js', () => ({
  DefaultPathResolver: vi.fn().mockImplementation(function (this: any) {
    this.projectRoot = '/tmp/test';
  }),
}));
vi.mock('../src/security/secret-vault.js', () => ({
  DefaultSecretVault: vi.fn().mockImplementation(function (this: any) {}),
  migratePlaintextSecrets: vi.fn().mockResolvedValue({ migrated: 0, file: '' }),
}));
vi.mock('../src/utils/wstack-paths.js', () => ({
  resolveWstackPaths: vi.fn().mockReturnValue(mockWpaths),
}));
vi.mock('../src/utils/term.js', () => ({ writeErr: (s: string) => process.stderr.write(s) }));

import { bootConfig } from '../src/boot.js';
import { migratePlaintextSecrets } from '../src/security/secret-vault.js';

const migrateMock = migratePlaintextSecrets as unknown as ReturnType<typeof vi.fn>;

describe('bootConfig (core)', () => {
  beforeEach(() => {
    mkdirMock.mockClear();
    writeFileMock.mockClear();
    migrateMock.mockReset();
    migrateMock.mockResolvedValue({ migrated: 0, file: '' });
  });

  it('returns the full canonical shape', async () => {
    const result = await bootConfig();
    expect(result.config.provider).toBe('anthropic');
    expect(result.projectRoot).toBe('/tmp/test');
    expect(result.globalConfigPath).toBe('/home/testuser/.wrongstack/config.json');
    expect(result.wpaths).toBe(mockWpaths);
    expect(result.vault).toBeDefined();
    expect(result.logger).toBeDefined();
  });

  it('creates the global, project, and session directories', async () => {
    await bootConfig();
    expect(mkdirMock).toHaveBeenCalledWith('/home/testuser/.wrongstack', { recursive: true });
    expect(mkdirMock).toHaveBeenCalledWith('/tmp/test/.wrongstack', { recursive: true });
    expect(mkdirMock).toHaveBeenCalledWith('/tmp/test/.wrongstack/sessions', { recursive: true });
  });

  it('writes the project meta file', async () => {
    await bootConfig();
    expect(writeFileMock).toHaveBeenCalledWith(
      '/tmp/test/.wrongstack/meta.json',
      expect.stringContaining('"hash": "abc123"'),
    );
  });

  it('uses the supplied appLabel in the plaintext-secret notice', async () => {
    migrateMock
      .mockResolvedValueOnce({ migrated: 2, file: '/path/global.json' })
      .mockResolvedValueOnce({ migrated: 0, file: '' });
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await bootConfig({ appLabel: 'WebUI' });
      expect(stderrWrites.some((w) => w.includes('[WebUI] Encrypted 2 plaintext'))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('swallows migration errors (best-effort)', async () => {
    migrateMock.mockRejectedValueOnce(new Error('vault locked'));
    await expect(bootConfig()).resolves.toBeDefined();
  });
});
