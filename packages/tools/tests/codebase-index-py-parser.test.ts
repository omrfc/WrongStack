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

import { parseSymbols } from '../src/codebase-index/py-parser.js';

const parse = (file = 'mod.py') => parseSymbols({ file, content: 'x = 1', lang: 'py' });

beforeEach(() => execFileSyncMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('py-parser parseSymbols', () => {
  it('maps the python runner JSON output into symbols', () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify([
        { name: 'Widget', kind: 'class', line: 1, col: 0, signature: 'class Widget: ...', scope: 'mod.Widget' },
      ]),
    );
    const res = parse();
    expect(res.symbols).toHaveLength(1);
    expect(res.symbols[0]?.name).toBe('Widget');
    expect(res.symbols[0]?.kind).toBe('class');
    expect(res.symbols[0]?.scope).toBe('mod.Widget');
  });

  it('defaults missing signature/scope to empty strings', () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([{ name: 'y', kind: 'var', line: 2, col: 0 }]));
    const sym = parse().symbols[0];
    expect(sym?.signature).toBe('');
    expect(sym?.scope).toBe('');
    expect(sym?.text).toBe('y');
  });

  it('returns no symbols when the runner emits empty output', () => {
    execFileSyncMock.mockReturnValue('  ');
    expect(parse().symbols).toEqual([]);
  });

  it('returns no symbols when the runner output is invalid JSON (exercises the catch)', () => {
    execFileSyncMock.mockReturnValue('boom');
    const res = parse();
    expect(res.symbols).toEqual([]);
    expect(res.file).toBe('mod.py');
  });
});
