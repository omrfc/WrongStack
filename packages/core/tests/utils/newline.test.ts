import { describe, expect, it } from 'vitest';
import { detectNewlineStyle, normalizeToLf, toStyle } from '../../src/utils/newline-normalize.js';

describe('newline-normalize', () => {
  it('detects LF', () => {
    expect(detectNewlineStyle('a\nb\n')).toBe('lf');
  });
  it('detects CRLF', () => {
    expect(detectNewlineStyle('a\r\nb\r\n')).toBe('crlf');
  });
  it('detects CR', () => {
    expect(detectNewlineStyle('a\rb\rc\r')).toBe('cr');
  });
  it('toStyle round-trips CRLF', () => {
    expect(toStyle('a\nb', 'crlf')).toBe('a\r\nb');
  });
  it('normalizeToLf collapses mixed', () => {
    expect(normalizeToLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});
