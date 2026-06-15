import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Override only `stat`; everything else (mkdtemp, realpath, rm, readFile) stays
// real so the sandbox + safeResolveReal path resolution still work.
const statMock = vi.fn();
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, default: actual, stat: (...a: unknown[]) => statMock(...a) };
});

import { editTool } from '../src/edit.js';
import { readTool } from '../src/read.js';
import { writeTool } from '../src/write.js';
import { type Sandbox, mkSandbox, newSignal } from './fixtures.js';

const eacces = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });

describe('fs tools rethrow non-ENOENT stat errors', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
    statMock.mockReset();
  });
  afterEach(async () => {
    await sb.cleanup();
    vi.restoreAllMocks();
  });

  it('read rethrows a non-ENOENT stat error', async () => {
    statMock.mockRejectedValue(eacces());
    await expect(
      readTool.execute({ path: 'x.txt' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/failed to stat|permission denied/);
  });

  it('write rethrows a non-ENOENT stat error', async () => {
    statMock.mockRejectedValue(eacces());
    await expect(
      writeTool.execute({ path: 'x.txt', content: 'hi' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/permission denied/);
  });

  it('edit rethrows a non-ENOENT stat error', async () => {
    statMock.mockRejectedValue(eacces());
    await expect(
      editTool.execute({ path: 'x.txt', old_string: 'a', new_string: 'b' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
