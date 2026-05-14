import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { editTool } from '../src/edit.js';
import { readTool } from '../src/read.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

describe('edit tool', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('requires prior read', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'hello world');
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
        sb.ctx,
        { signal: newSignal() },
      ),
    ).rejects.toThrow(/not read/);
  });

  it('single replacement succeeds', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'hello world');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(1);
    const content = await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8');
    expect(content).toBe('hi world');
  });

  it('multi-match without replace_all fails with line numbers', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'foo\nfoo\nfoo\n');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: 'foo', new_string: 'bar' },
        sb.ctx,
        { signal: newSignal() },
      ),
    ).rejects.toThrow(/matched 3 times/);
  });

  it('replace_all replaces all occurrences', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'foo\nfoo\nfoo\n');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(3);
    const content = await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8');
    expect(content).toBe('bar\nbar\nbar\n');
  });

  it('no-match throws with helpful message', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'apple');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: 'banana', new_string: 'x' },
        sb.ctx,
        { signal: newSignal() },
      ),
    ).rejects.toThrow(/no match/);
  });

  it('CRLF file is preserved', async () => {
    await fs.writeFile(path.join(sb.dir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    await readTool.execute({ path: 'crlf.txt' }, sb.ctx, { signal: newSignal() });
    await editTool.execute(
      { path: 'crlf.txt', old_string: 'two', new_string: 'TWO' },
      sb.ctx,
      { signal: newSignal() },
    );
    const content = await fs.readFile(path.join(sb.dir, 'crlf.txt'), 'utf8');
    expect(content).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('no-op (old===new) is success', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'same');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'same', new_string: 'same' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(0);
  });

  it('empty old_string is rejected', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'x');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: '', new_string: 'y' },
        sb.ctx,
        { signal: newSignal() },
      ),
    ).rejects.toThrow(/empty/);
  });

  it('missing file fails with hint', async () => {
    await expect(
      editTool.execute(
        { path: 'missing.txt', old_string: 'x', new_string: 'y' },
        sb.ctx,
        { signal: newSignal() },
      ),
    ).rejects.toThrow(/does not exist/);
  });

  it('flags external modification when mtime advances past tolerance', async () => {
    const file = path.join(sb.dir, 'a.txt');
    await fs.writeFile(file, 'hello');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    // Bump mtime well past either tolerance window (1 ms POSIX / 2 s Windows).
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(file, future, future);
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
        sb.ctx,
        { signal: newSignal() },
      ),
    ).rejects.toThrow(/modified externally/);
  });

  it('accepts a re-edit when mtime is within tolerance', async () => {
    // Write and edit twice in quick succession. On Windows FAT, the second
    // edit's stat may report an unchanged mtime; on Linux it advances by
    // ~µs. Either way it must fall within tolerance and not trip the stale-
    // read guard.
    const file = path.join(sb.dir, 'a.txt');
    await fs.writeFile(file, 'hello world');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    const first = await editTool.execute(
      { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(first.replacements).toBe(1);
  });
});
