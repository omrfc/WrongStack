import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HQ_AUTH_FILE_VERSION,
  defaultHqDataDir,
  emptyHqAuthFile,
  hqAuthFilePath,
  mintHqBrowserToken,
  mutateHqAuthFile,
  readHqAuthFile,
  resolveHqDataDir,
  writeHqAuthFile,
  type HqAuthFile,
} from '../../src/hq/auth-store.js';
import { wstackGlobalRoot } from '../../src/utils/wstack-paths.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-auth-'));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('HQ auth-store — defaultHqDataDir + resolveHqDataDir', () => {
  it('defaultHqDataDir points at <wstackGlobalRoot>/hq', () => {
    expect(defaultHqDataDir()).toBe(path.join(wstackGlobalRoot(), 'hq'));
  });

  it('resolveHqDataDir: no override + no env → default', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveHqDataDir(undefined, env)).toBe(defaultHqDataDir());
  });

  it('resolveHqDataDir: explicit override wins over env', () => {
    const env: NodeJS.ProcessEnv = { WRONGSTACK_HQ_DATA_DIR: '/from/env' };
    expect(resolveHqDataDir('/from/flag', env)).toBe(path.resolve('/from/flag'));
  });

  it('resolveHqDataDir: WRONGSTACK_HQ_DATA_DIR honored when no override', () => {
    const env: NodeJS.ProcessEnv = { WRONGSTACK_HQ_DATA_DIR: '/from/env' };
    expect(resolveHqDataDir(undefined, env)).toBe(path.resolve('/from/env'));
  });

  it('resolveHqDataDir: relative paths resolve against process.cwd()', () => {
    const env: NodeJS.ProcessEnv = {};
    const expected = path.resolve(process.cwd(), 'relative/hq');
    expect(resolveHqDataDir('relative/hq', env)).toBe(expected);
  });

  it('resolveHqDataDir: empty WRONGSTACK_HQ_DATA_DIR falls through to default', () => {
    const env: NodeJS.ProcessEnv = { WRONGSTACK_HQ_DATA_DIR: '   ' };
    expect(resolveHqDataDir(undefined, env)).toBe(defaultHqDataDir());
  });
});

describe('HQ auth-store — emptyHqAuthFile', () => {
  it('has the current schema version', () => {
    const f = emptyHqAuthFile();
    expect(f.version).toBe(HQ_AUTH_FILE_VERSION);
  });

  it('has an ISO updatedAt', () => {
    const f = emptyHqAuthFile();
    expect(() => new Date(f.updatedAt).toISOString()).not.toThrow();
    expect(new Date(f.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('does not carry redactionPolicy or browserTokens by default', () => {
    const f = emptyHqAuthFile();
    expect(f.redactionPolicy).toBeUndefined();
    expect(f.browserTokens).toBeUndefined();
  });
});

describe('HQ auth-store — hqAuthFilePath', () => {
  it('joins dataDir + auth.json', () => {
    expect(hqAuthFilePath('/tmp/hq')).toBe(path.join('/tmp/hq', 'auth.json'));
    expect(hqAuthFilePath('/tmp/hq/')).toBe(path.join('/tmp/hq/', 'auth.json'));
  });
});

describe('HQ auth-store — readHqAuthFile', () => {
  it('returns empty file when auth.json does not exist (ENOENT)', async () => {
    await withTempDir(async (dir) => {
      const f = await readHqAuthFile(dir);
      expect(f.version).toBe(HQ_AUTH_FILE_VERSION);
      expect(f.redactionPolicy).toBeUndefined();
    });
  });

  it('returns empty file + warns on corrupt JSON', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(hqAuthFilePath(dir), '{ not valid json');
      const warn = vi.fn();
      const f = await readHqAuthFile(dir, { warn });
      expect(f.version).toBe(HQ_AUTH_FILE_VERSION);
      expect(f.redactionPolicy).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('not valid JSON');
    });
  });

  it('returns empty file + warns on wrong schema version', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        hqAuthFilePath(dir),
        JSON.stringify({ version: 99, updatedAt: 'x' }),
      );
      const warn = vi.fn();
      const f = await readHqAuthFile(dir, { warn });
      expect(f.version).toBe(HQ_AUTH_FILE_VERSION);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('unsupported version');
    });
  });

  it('round-trips a well-formed file with redactionPolicy override', async () => {
    await withTempDir(async (dir) => {
      const original: HqAuthFile = {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: '2026-06-21T00:00:00.000Z',
        redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
        browserTokens: [{ id: 't1', token: 'abc', createdAt: '2026-06-21T00:00:00.000Z' }],
      };
      await writeHqAuthFile(dir, original);
      const readBack = await readHqAuthFile(dir);
      expect(readBack.version).toBe(HQ_AUTH_FILE_VERSION);
      expect(readBack.redactionPolicy).toEqual(original.redactionPolicy);
      expect(readBack.browserTokens).toEqual(original.browserTokens);
    });
  });
});

describe('HQ auth-store — writeHqAuthFile', () => {
  it('writes a file that can be parsed back', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, emptyHqAuthFile());
      const raw = await fs.readFile(hqAuthFilePath(dir), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  it('forces version=1 and refreshes updatedAt on write', async () => {
    await withTempDir(async (dir) => {
      const stale: HqAuthFile = {
        // caller passes a wrong version on purpose; write must clamp
        version: 99 as 1,
        updatedAt: '1999-01-01T00:00:00.000Z',
      };
      const before = Date.now();
      await writeHqAuthFile(dir, stale);
      const readBack = await readHqAuthFile(dir);
      expect(readBack.version).toBe(HQ_AUTH_FILE_VERSION);
      expect(new Date(readBack.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  it('creates the data directory if missing', async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, 'nested', 'deeper');
      await writeHqAuthFile(nested, emptyHqAuthFile());
      const stat = await fs.stat(hqAuthFilePath(nested));
      expect(stat.isFile()).toBe(true);
    });
  });

  it('sets mode 0o600 on a fresh file (best-effort on win32)', async () => {
    if (process.platform === 'win32') {
      // chmod is a no-op on Windows; skip the assertion rather than fail.
      return;
    }
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, emptyHqAuthFile());
      const stat = await fs.stat(hqAuthFilePath(dir));
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });
});

describe('HQ auth-store — mutateHqAuthFile', () => {
  it('applies the mutator to an empty starting file', async () => {
    await withTempDir(async (dir) => {
      const next = await mutateHqAuthFile(dir, (cur) => ({
        ...cur,
        redactionPolicy: { rawContent: false },
      }));
      expect(next.redactionPolicy).toEqual({ rawContent: false });
      const reread = await readHqAuthFile(dir);
      expect(reread.redactionPolicy).toEqual({ rawContent: false });
    });
  });

  it('preserves existing fields not touched by the mutator', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: '2026-06-21T00:00:00.000Z',
        redactionPolicy: { rawContent: false },
        browserTokens: [{ id: 't1', token: 'abc', createdAt: '2026-06-21T00:00:00.000Z' }],
      });
      const next = await mutateHqAuthFile(dir, (cur) => ({
        ...cur,
        redactionPolicy: { rawContent: true, toolArgs: 'none' },
      }));
      expect(next.browserTokens).toHaveLength(1);
      expect(next.redactionPolicy).toEqual({ rawContent: true, toolArgs: 'none' });
    });
  });
});

describe('HQ auth-store — mintHqBrowserToken', () => {
  it('produces a token with id + token + createdAt', () => {
    const t = mintHqBrowserToken();
    expect(typeof t.id).toBe('string');
    expect(t.id.length).toBeGreaterThan(0);
    expect(typeof t.token).toBe('string');
    expect(t.token.length).toBeGreaterThanOrEqual(32);
    expect(() => new Date(t.createdAt).toISOString()).not.toThrow();
  });

  it('carries the optional label', () => {
    const t = mintHqBrowserToken('my laptop');
    expect(t.label).toBe('my laptop');
  });

  it('mints unique tokens', () => {
    const a = mintHqBrowserToken();
    const b = mintHqBrowserToken();
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
  });
});
