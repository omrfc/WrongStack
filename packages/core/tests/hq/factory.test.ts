import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, resolveHqConfigFromEnv, writeHqAuthFile, writeHqRuntimeFile } from '../../src/hq/index.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-factory-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('HQ publisher factory env config', () => {
  it('uses WRONGSTACK_HQ_TOKEN when explicitly provided', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [{ id: 'ct-1', token: 'auth-file-token', createdAt: new Date().toISOString() }],
      });

      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_URL: 'http://127.0.0.1:3499',
        WRONGSTACK_HQ_TOKEN: 'explicit-token',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });

      expect(config).toMatchObject({ url: 'http://127.0.0.1:3499', token: 'explicit-token' });
    });
  });

  it('auto-loads the first client token from auth.json when HQ is enabled', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [{ id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() }],
      });

      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_ENABLED: '1',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });

      expect(config).toEqual({
        url: 'http://127.0.0.1:3499',
        enabled: true,
        token: 'client-token-from-auth',
      });
    });
  });

  it('auto-loads the first client token from auth.json when only URL is provided', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        browserTokens: [{ id: 'bt-1', token: 'browser-token-ignored', createdAt: new Date().toISOString() }],
        clientTokens: [{ id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() }],
      });

      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_URL: 'http://127.0.0.1:3499',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });

      expect(config).toMatchObject({ url: 'http://127.0.0.1:3499', token: 'client-token-from-auth' });
    });
  });

  it('auto-enables same-machine HQ when auth.json has a client token', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [{ id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() }],
      });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir })).toEqual({
        url: 'http://127.0.0.1:3499',
        enabled: true,
        token: 'client-token-from-auth',
      });
    });
  });

  it('auto-enables open-mode same-machine HQ when only a runtime URL exists', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        browserTokens: [],
        clientTokens: [],
      });
      await writeHqRuntimeFile(dir, { url: 'http://127.0.0.1:45123', pid: process.pid });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir })).toEqual({
        url: 'http://127.0.0.1:45123',
        enabled: true,
      });
    });
  });

  it('prefers the runtime HQ URL when the server bound a non-default port', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [{ id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() }],
      });
      await writeHqRuntimeFile(dir, { url: 'http://127.0.0.1:45123', pid: process.pid });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir })).toEqual({
        url: 'http://127.0.0.1:45123',
        enabled: true,
        token: 'client-token-from-auth',
      });
    });
  });

  it('ignores a runtime HQ URL whose recorded process is no longer alive', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [{ id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() }],
      });
      await writeHqRuntimeFile(dir, { url: 'http://127.0.0.1:45123', pid: 999_999_999 });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir })).toEqual({
        url: 'http://127.0.0.1:3499',
        enabled: true,
        token: 'client-token-from-auth',
      });
    });
  });

  it('does not auto-enable local HQ when explicitly disabled', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [{ id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() }],
      });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir, WRONGSTACK_HQ_ENABLED: '0' })).toBeUndefined();
    });
  });
});
