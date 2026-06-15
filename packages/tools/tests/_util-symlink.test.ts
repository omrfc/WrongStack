import type { Context } from '@wrongstack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const realpathMock = vi.fn();

vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  realpath: (...a: unknown[]) => realpathMock(...a),
}));

import { assertRealInsideRoot, safeResolveReal } from '../src/_util.js';

const ctx = () => ({ cwd: '/tmp/project', projectRoot: '/tmp/project' }) as Context;

afterEach(() => {
  realpathMock.mockReset();
  vi.restoreAllMocks();
});

describe('assertRealInsideRoot — realpath error handling', () => {
  it('rethrows a non-ENOENT realpath error (e.g. EACCES)', async () => {
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    realpathMock.mockRejectedValue(eacces);
    // realRoot resolution swallows the error (.catch), but the probe realpath
    // rethrows because the code is not ENOENT.
    await expect(assertRealInsideRoot('/tmp/project/a.txt', ctx())).rejects.toThrow(/permission denied/);
  });

  it('walks up past ENOENT ancestors and passes when nothing escapes', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    // realRoot resolves (first call), then the target + one ancestor are ENOENT,
    // finally an existing ancestor resolves back inside the root.
    realpathMock
      .mockResolvedValueOnce('/tmp/project') // realRoot
      .mockRejectedValueOnce(enoent) // /tmp/project/new/file.txt
      .mockResolvedValueOnce('/tmp/project/new'); // /tmp/project/new (exists)
    await expect(safeResolveReal('new/file.txt', ctx())).resolves.toContain('file.txt');
  });

  it('returns safely when every ancestor is missing (walks up to fs root)', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    realpathMock.mockRejectedValue(enoent); // realRoot + every probe ENOENT
    await expect(assertRealInsideRoot('/tmp/project/a/b.txt', ctx())).resolves.toBeUndefined();
  });

  it('throws when the realpath escapes the project root via a symlink', async () => {
    realpathMock
      .mockResolvedValueOnce('/tmp/project') // realRoot
      .mockResolvedValueOnce('/tmp/elsewhere/secret'); // target resolves outside
    await expect(assertRealInsideRoot('/tmp/project/link.txt', ctx())).rejects.toThrow(
      /outside project root/,
    );
  });
});
