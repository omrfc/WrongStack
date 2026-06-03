import { describe, expect, it } from 'vitest';
import { SKIP_DIRS, isHiddenEntry, rankFiles } from '../../src/server/file-picker.js';

/**
 * Pure filtering + ranking behind the `files.list` `@`-mention picker. The
 * scoring weights, depth penalty, and tie-break order are easy to regress
 * silently, so pin them here.
 */

describe('isHiddenEntry', () => {
  it('hides dotfiles by default', () => {
    expect(isHiddenEntry('.DS_Store')).toBe(true);
    expect(isHiddenEntry('.vscode')).toBe(true);
  });
  it('keeps a few commonly-wanted dotfiles', () => {
    for (const name of ['.wrongstack', '.env.example', '.gitignore', '.eslintrc', '.prettierrc']) {
      expect(isHiddenEntry(name)).toBe(false);
    }
  });
  it('never hides normal files/dirs', () => {
    expect(isHiddenEntry('src')).toBe(false);
    expect(isHiddenEntry('index.ts')).toBe(false);
  });
});

describe('SKIP_DIRS', () => {
  it('includes the heavyweight build/vcs/dependency dirs', () => {
    for (const d of ['.git', 'node_modules', 'dist', 'build', 'coverage', 'target']) {
      expect(SKIP_DIRS.has(d)).toBe(true);
    }
    expect(SKIP_DIRS.has('src')).toBe(false);
  });
});

describe('rankFiles', () => {
  const files = ['src/index.ts', 'src/server/index.ts', 'README.md', 'src/util/index.helper.ts'];

  it('returns all paths alphabetically (capped) for an empty query', () => {
    // Empty query → every path scores 0, so the sort falls through to the
    // lexicographic tie-break. 'README.md' sorts before the 'src/…' paths.
    expect(rankFiles(files, '', 2)).toEqual(['README.md', 'src/index.ts']);
  });

  it('ranks exact basename match above prefix above substring', () => {
    const ranked = rankFiles(
      ['a/readme.md', 'b/readme.md.bak', 'c/notes-readme.md'],
      'readme.md',
      50,
    );
    // exact basename 'readme.md' (a/) first; then prefix 'readme.md...' (b/);
    // then substring (c/).
    expect(ranked).toEqual(['a/readme.md', 'b/readme.md.bak', 'c/notes-readme.md']);
  });

  it('drops non-matching paths', () => {
    expect(rankFiles(['src/index.ts', 'docs/guide.md'], 'index', 50)).toEqual(['src/index.ts']);
  });

  it('prefers shallower paths on equal score (depth penalty)', () => {
    // Both are exact basename matches for "index.ts" → depth penalty decides.
    expect(rankFiles(['a/b/c/index.ts', 'index.ts'], 'index.ts', 50)).toEqual([
      'index.ts',
      'a/b/c/index.ts',
    ]);
  });

  it('is case-insensitive and caps to limit', () => {
    // 'SRC/App.TSX' and 'x/app.tsx' are both exact basename matches (depth 2);
    // 'src/app.test.tsx' is neither prefix nor substring → dropped. The two
    // survivors tie on score, so assert membership, not locale-dependent order.
    const ranked = rankFiles(['SRC/App.TSX', 'src/app.test.tsx', 'x/app.tsx'], 'app.tsx', 2);
    expect(ranked).toHaveLength(2);
    expect(ranked).toContain('SRC/App.TSX');
    expect(ranked).toContain('x/app.tsx');
  });
});
