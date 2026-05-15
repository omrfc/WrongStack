import { describe, expect, it } from 'vitest';
import { color, stripAnsi } from '../../src/index.js';

describe('color helpers', () => {
  it('produces strings (with or without escapes depending on TTY)', () => {
    const out = color.red('x');
    expect(typeof out).toBe('string');
    expect(out).toContain('x');
  });

  it('stripAnsi removes escapes', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[39m')).toBe('hello');
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('stripAnsi handles compound sequences', () => {
    expect(stripAnsi('\x1b[1;33;41mWARN\x1b[0m')).toBe('WARN');
  });

  it('exposes all expected colour helpers', () => {
    const keys = [
      'reset',
      'bold',
      'dim',
      'italic',
      'underline',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'gray',
      'amber',
      'pink',
      'bgRed',
      'bgGreen',
    ] as const;
    for (const k of keys) {
      expect(typeof (color as Record<string, unknown>)[k]).toBe('function');
    }
  });
});
