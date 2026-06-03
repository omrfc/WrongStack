import { afterEach, describe, expect, it } from 'vitest';
import { getTermSize, isInteractive, isStdinTTY, isStdoutTTY } from '../../src/utils/term.js';

describe('term helpers', () => {
  // Snapshot the original stream props so afterEach can restore them, even
  // when the test environment started non-TTY (CI: isTTY is typically
  // undefined). configurable:true is required so defineProperty can overwrite
  // the readonly native getter.
  const orig = {
    in: process.stdin.isTTY,
    out: process.stdout.isTTY,
    rows: process.stdout.rows,
    cols: process.stdout.columns,
  } as const;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: orig.in, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: orig.out, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: orig.rows, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: orig.cols, configurable: true });
  });

  function setTty(inTty: boolean, outTty: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
  }

  describe('isStdoutTTY', () => {
    it('returns true when stdout is a TTY', () => {
      setTty(false, true);
      expect(isStdoutTTY()).toBe(true);
    });

    it('returns false when stdout is piped/redirected', () => {
      setTty(false, false);
      expect(isStdoutTTY()).toBe(false);
    });
  });

  describe('isStdinTTY', () => {
    it('returns true when stdin is a TTY', () => {
      setTty(true, false);
      expect(isStdinTTY()).toBe(true);
    });

    it('returns false when stdin is piped/redirected', () => {
      setTty(false, false);
      expect(isStdinTTY()).toBe(false);
    });
  });

  describe('isInteractive', () => {
    it('is true only when both streams are TTYs', () => {
      setTty(true, true);
      expect(isInteractive()).toBe(true);
    });

    it('is false when only stdin is a TTY', () => {
      setTty(true, false);
      expect(isInteractive()).toBe(false);
    });

    it('is false when only stdout is a TTY', () => {
      setTty(false, true);
      expect(isInteractive()).toBe(false);
    });

    it('is false when neither stream is a TTY', () => {
      setTty(false, false);
      expect(isInteractive()).toBe(false);
    });
  });

  describe('getTermSize', () => {
    it('returns the live terminal size when available', () => {
      Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      expect(getTermSize()).toEqual({ rows: 30, cols: 100 });
    });

    it('falls back to 24x80 when size is unavailable', () => {
      Object.defineProperty(process.stdout, 'rows', { value: undefined, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
      expect(getTermSize()).toEqual({ rows: 24, cols: 80 });
    });
  });
});
