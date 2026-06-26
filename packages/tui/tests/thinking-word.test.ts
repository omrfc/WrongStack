import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TUI_THINKING_WORD,
  MAX_TUI_THINKING_WORD_LENGTH,
  TUI_THINKING_WORD_POOL,
  isRandomTuiThinkingWord,
  normalizeTuiThinkingWord,
  pickRandomTuiThinkingWord,
} from '../src/thinking-word.js';

describe('TUI_THINKING_WORD_POOL', () => {
  it('has at least 20 fun words', () => {
    expect(TUI_THINKING_WORD_POOL.length).toBeGreaterThanOrEqual(20);
  });

  it('every entry is a valid statusline word (survives normalize)', () => {
    for (const word of TUI_THINKING_WORD_POOL) {
      expect(word.length).toBeLessThanOrEqual(MAX_TUI_THINKING_WORD_LENGTH);
      expect(normalizeTuiThinkingWord(word)).toBe(word);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(TUI_THINKING_WORD_POOL).size).toBe(TUI_THINKING_WORD_POOL.length);
  });
});

describe('isRandomTuiThinkingWord', () => {
  it('treats unset / empty as random', () => {
    expect(isRandomTuiThinkingWord(undefined)).toBe(true);
    expect(isRandomTuiThinkingWord('')).toBe(true);
    expect(isRandomTuiThinkingWord('   ')).toBe(true);
  });

  it('treats the literal default and "random" (any case) as random', () => {
    expect(isRandomTuiThinkingWord(DEFAULT_TUI_THINKING_WORD)).toBe(true);
    expect(isRandomTuiThinkingWord('Thinking')).toBe(true);
    expect(isRandomTuiThinkingWord('random')).toBe(true);
    expect(isRandomTuiThinkingWord('RANDOM')).toBe(true);
  });

  it('treats an explicit custom word as fixed', () => {
    expect(isRandomTuiThinkingWord('cooking')).toBe(false);
    expect(isRandomTuiThinkingWord('vibing')).toBe(false);
  });
});

describe('pickRandomTuiThinkingWord', () => {
  it('always returns a word from the pool', () => {
    for (let i = 0; i < 200; i++) {
      expect(TUI_THINKING_WORD_POOL).toContain(pickRandomTuiThinkingWord());
    }
  });

  it('never repeats the previous word when avoidable', () => {
    for (let i = 0; i < 200; i++) {
      const prev = pickRandomTuiThinkingWord();
      expect(pickRandomTuiThinkingWord(prev)).not.toBe(prev);
    }
  });

  it('still returns a pool word when previous is not in the pool', () => {
    expect(TUI_THINKING_WORD_POOL).toContain(pickRandomTuiThinkingWord('banana'));
  });
});
