import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite, ensureDir } from '../../src/utils/atomic-write.js';

describe('atomicWrite', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-aw-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a new file', async () => {
    const file = path.join(dir, 'a.txt');
    await atomicWrite(file, 'hello');
    expect(await fs.readFile(file, 'utf8')).toBe('hello');
  });

  it('overwrites existing file', async () => {
    const file = path.join(dir, 'b.txt');
    await fs.writeFile(file, 'old');
    await atomicWrite(file, 'new');
    expect(await fs.readFile(file, 'utf8')).toBe('new');
  });

  it('leaves no orphan tmp file on success', async () => {
    const file = path.join(dir, 'c.txt');
    await atomicWrite(file, 'x');
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('creates parent directories', async () => {
    const file = path.join(dir, 'nested', 'deep', 'd.txt');
    await atomicWrite(file, 'ok');
    expect(await fs.readFile(file, 'utf8')).toBe('ok');
  });

  it('accepts a Uint8Array body and preserves bytes', async () => {
    const file = path.join(dir, 'bin.dat');
    const buf = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    await atomicWrite(file, buf);
    const onDisk = await fs.readFile(file);
    expect(Array.from(onDisk)).toEqual(Array.from(buf));
  });

  it('preserves target file mode when overwriting', async () => {
    if (process.platform === 'win32') return; // Windows has limited mode semantics
    const file = path.join(dir, 'modes.txt');
    await fs.writeFile(file, 'old', { mode: 0o644 });
    await fs.chmod(file, 0o600);
    await atomicWrite(file, 'new');
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('uses a custom encoding when provided', async () => {
    const file = path.join(dir, 'enc.txt');
    await atomicWrite(file, 'héllo', { encoding: 'utf8' });
    expect(await fs.readFile(file, 'utf8')).toBe('héllo');
  });

  it('rethrows the error and cleans up the tmp file when writeFile fails', async () => {
    const file = path.join(dir, 'failed.txt');
    // Pre-create the target as a directory — fs.rename onto an existing dir
    // fails on POSIX, exercising the catch + tmp-cleanup branch.
    await fs.mkdir(file, { recursive: true });
    await expect(atomicWrite(file, 'wat')).rejects.toBeTruthy();
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });
});

describe('ensureDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ed-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a missing directory', async () => {
    const target = path.join(dir, 'a', 'b', 'c');
    await ensureDir(target);
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent', async () => {
    const target = path.join(dir, 'existing');
    await fs.mkdir(target);
    await expect(ensureDir(target)).resolves.toBeUndefined();
  });
});
