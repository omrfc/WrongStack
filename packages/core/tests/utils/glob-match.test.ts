import { describe, expect, it } from 'vitest';
import { matchAny, matchGlob } from '../../src/utils/glob-match.js';

describe('glob-match', () => {
  it('matches *', () => {
    expect(matchGlob('*.ts', 'foo.ts')).toBe(true);
    expect(matchGlob('*.ts', 'src/foo.ts')).toBe(false);
  });

  it('matches **', () => {
    expect(matchGlob('**/*.ts', 'src/foo.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'foo.ts')).toBe(true);
    expect(matchGlob('src/**', 'src/foo/bar.ts')).toBe(true);
  });

  it('matches ?', () => {
    expect(matchGlob('a?c', 'abc')).toBe(true);
    expect(matchGlob('a?c', 'a/c')).toBe(false);
  });

  it('character classes', () => {
    expect(matchGlob('[abc].txt', 'a.txt')).toBe(true);
    expect(matchGlob('[abc].txt', 'd.txt')).toBe(false);
  });

  it('matchAny short-circuits', () => {
    expect(matchAny(['*.js', '*.ts'], 'foo.ts')).toBe(true);
    expect(matchAny(['*.js', '*.go'], 'foo.ts')).toBe(false);
  });

  it('character class negation works with [!...] (shell convention)', () => {
    expect(matchGlob('[!abc].txt', 'd.txt')).toBe(true);
    expect(matchGlob('[!abc].txt', 'a.txt')).toBe(false);
  });

  it('character class negation works with [^...] (regex convention)', () => {
    expect(matchGlob('[^abc].txt', 'd.txt')).toBe(true);
    expect(matchGlob('[^abc].txt', 'a.txt')).toBe(false);
  });

  it('character class supports ranges', () => {
    expect(matchGlob('file[0-9].txt', 'file7.txt')).toBe(true);
    expect(matchGlob('file[0-9].txt', 'fileA.txt')).toBe(false);
    expect(matchGlob('file[a-z].txt', 'fileq.txt')).toBe(true);
  });
});
