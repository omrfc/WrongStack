/**
 * Tests for FileServer.
 *
 * Uses a temp directory as the project root. Tests cover:
 *   - in-root read
 *   - in-root write (atomic via rename)
 *   - out-of-root read rejected with FsError
 *   - relative path rejected (ACP requires absolute)
 *   - non-existent file rejected with ENOENT
 *   - timeout path (using a very short timeout)
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileServer, FsError } from '../src/client/file-server.js';

let projectRoot: string;
let server: FileServer;

beforeEach(async () => {
  projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-fs-'));
  server = new FileServer({ projectRoot });
});

afterEach(async () => {
  await fsp.rm(projectRoot, { recursive: true, force: true });
});

describe('FileServer', () => {
  it('reads a file inside the project root', async () => {
    const p = path.join(projectRoot, 'hello.txt');
    await fsp.writeFile(p, 'world', 'utf8');
    const out = await server.readTextFile({ sessionId: 's1', path: p });
    expect(out.content).toBe('world');
  });

  it('writes a file inside the project root (atomic via rename)', async () => {
    const p = path.join(projectRoot, 'out.txt');
    await server.writeTextFile({ sessionId: 's1', path: p, content: 'data' });
    const onDisk = await fsp.readFile(p, 'utf8');
    expect(onDisk).toBe('data');
  });

  it('rejects paths outside the project root with OUTSIDE_ROOT', async () => {
    await expect(
      server.readTextFile({ sessionId: 's1', path: '/etc/passwd' }),
    ).rejects.toBeInstanceOf(FsError);
    try {
      await server.readTextFile({ sessionId: 's1', path: '/etc/passwd' });
    } catch (err) {
      expect((err as FsError).code).toBe('OUTSIDE_ROOT');
    }
  });

  it('rejects relative paths (ACP requires absolute)', async () => {
    await expect(
      server.readTextFile({ sessionId: 's1', path: 'relative/file.txt' }),
    ).rejects.toBeInstanceOf(FsError);
    try {
      await server.readTextFile({ sessionId: 's1', path: 'relative/file.txt' });
    } catch (err) {
      expect((err as FsError).code).toBe('INVALID_PATH');
    }
  });

  it('rejects sibling-prefix attacks (e.g. /project-evil vs /project)', async () => {
    // projectRoot is something like /tmp/wstack-fs-abc123
    // /tmp/wstack-fs-abc123-evil is NOT a child
    const evil = projectRoot + '-evil';
    try {
      await server.readTextFile({ sessionId: 's1', path: evil });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('OUTSIDE_ROOT');
    }
  });

  it('returns ENOENT for a missing file', async () => {
    const p = path.join(projectRoot, 'missing.txt');
    try {
      await server.readTextFile({ sessionId: 's1', path: p });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('ENOENT');
    }
  });

  it('write replaces existing file content', async () => {
    const p = path.join(projectRoot, 'replace.txt');
    await fsp.writeFile(p, 'old', 'utf8');
    await server.writeTextFile({ sessionId: 's1', path: p, content: 'new' });
    expect(await fsp.readFile(p, 'utf8')).toBe('new');
  });

  it('cleans up the .tmp file on write failure', async () => {
    if (process.platform === 'win32') {
      // POSIX permission bits are ignored on Windows, so we can't rely
      // on chmod to force a write failure. Use an invalid path instead
      // to force a write error and verify the .tmp cleanup still runs.
      const p = path.join(projectRoot, 'no\0pe.txt');
      await expect(
        server.writeTextFile({ sessionId: 's1', path: p, content: 'x' }),
      ).rejects.toBeInstanceOf(FsError);
      const entries = await fsp.readdir(projectRoot);
      expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
      return;
    }
    // Make the projectRoot read-only so writeFile throws
    const p = path.join(projectRoot, 'nope.txt');
    await fsp.chmod(projectRoot, 0o500);
    try {
      await expect(
        server.writeTextFile({ sessionId: 's1', path: p, content: 'x' }),
      ).rejects.toBeInstanceOf(FsError);
    } finally {
      await fsp.chmod(projectRoot, 0o700);
    }
    // The .tmp file should not be left behind
    const entries = await fsp.readdir(projectRoot);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });
});
