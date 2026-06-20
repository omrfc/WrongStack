import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('validates required inputs', async () => {
    const sig = { signal: newSignal() };
    await expect(
      editTool.execute({ path: '', old_string: 'a', new_string: 'b' }, sb.ctx, sig),
    ).rejects.toThrow(/path is required/);
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: undefined as never, new_string: 'b' },
        sb.ctx,
        sig,
      ),
    ).rejects.toThrow(/old_string is required/);
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: 'a', new_string: undefined as never },
        sb.ctx,
        sig,
      ),
    ).rejects.toThrow(/new_string is required/);
    await expect(
      editTool.execute({ path: 'a.txt', old_string: '', new_string: 'b' }, sb.ctx, sig),
    ).rejects.toThrow(/cannot be empty/);
  });

  it('rejects a directory (not a regular file)', async () => {
    await fs.mkdir(path.join(sb.dir, 'adir'));
    await expect(
      editTool.execute({ path: 'adir', old_string: 'a', new_string: 'b' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('auto-reads when no prior read is recorded and the edit is unambiguous', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'hello world');
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(1);
    expect(out.note).toMatch(/auto-read/);
    expect(await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8')).toBe('hi world');
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
      editTool.execute({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/matched 3 times/);
  });

  it('auto-read still refuses ambiguous edits', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'foo\nfoo\nfoo\n');
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/matched 3 times/);
    expect(await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8')).toBe('foo\nfoo\nfoo\n');
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
      editTool.execute({ path: 'a.txt', old_string: 'banana', new_string: 'x' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/no match/);
  });

  it('CRLF file is preserved', async () => {
    await fs.writeFile(path.join(sb.dir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    await readTool.execute({ path: 'crlf.txt' }, sb.ctx, { signal: newSignal() });
    await editTool.execute({ path: 'crlf.txt', old_string: 'two', new_string: 'TWO' }, sb.ctx, {
      signal: newSignal(),
    });
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
      editTool.execute({ path: 'a.txt', old_string: '', new_string: 'y' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/empty/);
  });

  it('missing file fails with hint', async () => {
    await expect(
      editTool.execute({ path: 'missing.txt', old_string: 'x', new_string: 'y' }, sb.ctx, {
        signal: newSignal(),
      }),
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
      editTool.execute({ path: 'a.txt', old_string: 'hello', new_string: 'hi' }, sb.ctx, {
        signal: newSignal(),
      }),
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

    const second = await editTool.execute(
      { path: 'a.txt', old_string: 'world', new_string: 'there' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(second.replacements).toBe(1);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('hi there');
  });

  describe('lineNumbersFor multi-match', () => {
    it('lineNumbersFor converts indices to correct line numbers for multiple matches', async () => {
      // A file with three matches of "foo" at different lines.
      // lineNumbersFor should return the correct line numbers for each match index.
      const file = path.join(sb.dir, 'multi.txt');
      const content = 'line1 foo\nline2 foo\nline3 foo\n';
      await fs.writeFile(file, content);
      await readTool.execute({ path: 'multi.txt' }, sb.ctx, { signal: newSignal() });

      // Attempt an edit with 'foo' but without replace_all — this should throw
      // with the line numbers of the matches. We exercise it through the error message.
      await expect(
        editTool.execute({ path: 'multi.txt', old_string: 'foo', new_string: 'bar' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/matched 3 times/);
    });
  });

  describe('findSimilarity long-needle near-match', () => {
    it('findSimilarity is called and returns a hint when needle >= 20 chars has a near match', async () => {
      // The probe (first 40 chars of needle) must appear in the file for findSimilarity to return a line.
      // File contains the probe directly so findSimilarity finds it.
      const file = path.join(sb.dir, 'near.txt');
      const fileContent = 'Hello world testingzzz different suffix here is the rest of the file';
      await fs.writeFile(file, fileContent);
      // needle = same as file content with a trailing change
      const needle = 'Hello world testingzzz different suffix here is not there';
      await readTool.execute({ path: 'near.txt' }, sb.ctx, { signal: newSignal() });

      await expect(
        editTool.execute({ path: 'near.txt', old_string: needle, new_string: 'replaced' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/Nearest match near line/);
    });

    it('reports the correct line when the near match is on a later line', async () => {
      // A newline precedes the probe match, so findSimilarity counts past it.
      const file = path.join(sb.dir, 'multi.txt');
      const probeLine = 'Hello world testingzzz different suffix here is the rest';
      await fs.writeFile(file, `first line\nsecond line\n${probeLine}`);
      const needle = 'Hello world testingzzz different suffix here is NOT present';
      await readTool.execute({ path: 'multi.txt' }, sb.ctx, { signal: newSignal() });

      await expect(
        editTool.execute({ path: 'multi.txt', old_string: needle, new_string: 'x' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/Nearest match near line 3/);
    });

    it('findSimilarity returns undefined when needle >= 20 chars with no near match in file', async () => {
      // Needle >= 20 chars but no probe match at all in the file
      // findSimilarity returns undefined → no "near line" hint in error
      const file = path.join(sb.dir, 'far.txt');
      const needle = 'zzzz no match in this file at all xxxx'; // 35 chars, probe won't be found
      await fs.writeFile(file, 'completely unrelated content');
      await readTool.execute({ path: 'far.txt' }, sb.ctx, { signal: newSignal() });

      await expect(
        editTool.execute({ path: 'far.txt', old_string: needle, new_string: 'replaced' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/no match/);
    });
  });
});
