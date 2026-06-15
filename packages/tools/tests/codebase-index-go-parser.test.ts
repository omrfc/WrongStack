import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { parseSymbols } from '../src/codebase-index/go-parser.js';

const parse = (content: string, file = 'main.go') => parseSymbols({ file, content, lang: 'go' });

beforeEach(() => execFileSyncMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('go-parser parseSymbols', () => {
  it('maps the go runner JSON output into symbols', () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify([
        { name: 'Main', kind: 'function', line: 5, col: 1, signature: 'func Main()', scope: 'main' },
      ]),
    );
    const res = parse('package main');
    expect(res.symbols).toHaveLength(1);
    expect(res.symbols[0]?.name).toBe('Main');
    expect(res.symbols[0]?.signature).toBe('func Main()');
    expect(res.symbols[0]?.scope).toBe('main');
  });

  it('defaults missing signature/scope to empty strings', () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify([{ name: 'X', kind: 'var', line: 1, col: 0 }]),
    );
    const sym = parse('package p').symbols[0];
    expect(sym?.signature).toBe('');
    expect(sym?.scope).toBe('');
    expect(sym?.text).toBe('X');
  });

  it('returns no symbols when the runner emits empty output', () => {
    execFileSyncMock.mockReturnValue('   ');
    expect(parse('package main').symbols).toEqual([]);
  });

  it('returns no symbols when the runner output is invalid JSON (exercises the catch)', () => {
    // JSON.parse throwing drives the same defensive catch as a missing `go`.
    execFileSyncMock.mockReturnValue('<not json>');
    const res = parse('package main');
    expect(res.symbols).toEqual([]);
    expect(res.file).toBe('main.go');
  });
});
