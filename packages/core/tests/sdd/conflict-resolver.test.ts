import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import {
  makePreferSideConflictResolver,
  makeLlmConflictResolver,
  resolveConflictText,
  hasConflictMarkers,
} from '../../src/sdd/conflict-resolver.js';
import type { TaskNode } from '../../src/types/task-graph.js';

const TWO_WAY = ['top', '<<<<<<< HEAD', 'ours-1', '=======', 'theirs-1', '>>>>>>> branch', 'bottom'].join(
  '\n',
);
const DIFF3 = [
  'top',
  '<<<<<<< HEAD',
  'ours-1',
  '||||||| base',
  'base-1',
  '=======',
  'theirs-1',
  '>>>>>>> branch',
  'bottom',
].join('\n');

const task = { id: 't1', title: 'T', metadata: {} } as unknown as TaskNode;

describe('resolveConflictText', () => {
  it('keeps the incoming (theirs) side', () => {
    expect(resolveConflictText(TWO_WAY, 'incoming')).toBe('top\ntheirs-1\nbottom');
  });
  it('keeps the base (ours) side', () => {
    expect(resolveConflictText(TWO_WAY, 'base')).toBe('top\nours-1\nbottom');
  });
  it('handles diff3 markers (drops the |||| base section)', () => {
    expect(resolveConflictText(DIFF3, 'incoming')).toBe('top\ntheirs-1\nbottom');
    expect(resolveConflictText(DIFF3, 'base')).toBe('top\nours-1\nbottom');
  });
  it('resolves multiple hunks and leaves no markers', () => {
    const txt = `${TWO_WAY}\n${TWO_WAY}`;
    const out = resolveConflictText(txt, 'incoming');
    expect(hasConflictMarkers(out)).toBe(false);
    expect(out.match(/theirs-1/g)?.length).toBe(2);
  });
  it('leaves clean text untouched', () => {
    expect(resolveConflictText('a\nb\nc', 'incoming')).toBe('a\nb\nc');
  });
});

describe('makePreferSideConflictResolver', () => {
  it('rewrites conflicted files on disk and returns true', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-'));
    try {
      writeFileSync(path.join(dir, 'a.txt'), TWO_WAY);
      const resolver = makePreferSideConflictResolver('incoming');
      const ok = await resolver({ task, conflictFiles: ['a.txt'], cwd: dir });
      expect(ok).toBe(true);
      expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('top\ntheirs-1\nbottom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for an empty file list or an unreadable file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-'));
    try {
      const resolver = makePreferSideConflictResolver('base');
      expect(await resolver({ task, conflictFiles: [], cwd: dir })).toBe(false);
      expect(await resolver({ task, conflictFiles: ['missing.txt'], cwd: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('makeLlmConflictResolver', () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crl-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('writes the model-resolved file (unfencing a code block)', async () => {
    await withDir(async (dir) => {
      writeFileSync(path.join(dir, 'a.txt'), TWO_WAY);
      const resolver = makeLlmConflictResolver({
        run: async () => '```\ntop\nours-1+theirs-1\nbottom\n```',
      });
      expect(await resolver({ task, conflictFiles: ['a.txt'], cwd: dir })).toBe(true);
      expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('top\nours-1+theirs-1\nbottom');
    });
  });

  it('rejects a resolution that still has markers or is empty', async () => {
    await withDir(async (dir) => {
      writeFileSync(path.join(dir, 'a.txt'), TWO_WAY);
      expect(await makeLlmConflictResolver({ run: async () => TWO_WAY })({ task, conflictFiles: ['a.txt'], cwd: dir })).toBe(false);
      expect(await makeLlmConflictResolver({ run: async () => '   ' })({ task, conflictFiles: ['a.txt'], cwd: dir })).toBe(false);
      // File untouched after a rejected resolution.
      expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(TWO_WAY);
    });
  });

  it('rejects a resolution that drops most of the file (content-loss guard)', async () => {
    await withDir(async (dir) => {
      const big = ['<<<<<<< HEAD', ...Array.from({ length: 20 }, (_, i) => `o${i}`), '=======', ...Array.from({ length: 20 }, (_, i) => `t${i}`), '>>>>>>> b'].join('\n');
      writeFileSync(path.join(dir, 'a.txt'), big);
      const resolver = makeLlmConflictResolver({ run: async () => 'just one line' });
      expect(await resolver({ task, conflictFiles: ['a.txt'], cwd: dir })).toBe(false);
    });
  });

  it('returns false on a runner throw or empty file list', async () => {
    await withDir(async (dir) => {
      writeFileSync(path.join(dir, 'a.txt'), TWO_WAY);
      expect(await makeLlmConflictResolver({ run: async () => { throw new Error('down'); } })({ task, conflictFiles: ['a.txt'], cwd: dir })).toBe(false);
      expect(await makeLlmConflictResolver({ run: async () => 'x' })({ task, conflictFiles: [], cwd: dir })).toBe(false);
    });
  });
});
