import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
  spawnSync: (...a: unknown[]) => spawnSyncMock(...a),
}));

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { parseSymbols } from '../src/codebase-index/rs-parser.js';

const parse = (content: string, file = 'lib.rs') => parseSymbols({ file, content, lang: 'rs' });
const find = (content: string, name: string) => parse(content).symbols.find((s) => s.name === name);

/** Force the native-parser probe to report "unavailable" so the regex path runs. */
const forceRegex = () =>
  execFileSyncMock.mockImplementation(() => {
    throw new Error('rustc missing');
  });

beforeEach(() => {
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('rs-parser regex fallback', () => {
  it('extracts every Rust declaration kind', () => {
    forceRegex();
    const content = [
      'fn do_thing(a: i32) {}',
      'struct Point {}',
      'enum Color {}',
      'trait Draw {}',
      'impl Point {}',
      'type Alias = i32;',
      'const MAX: i32 = 1;',
      'static GLOBAL: i32 = 2;',
      'mod utils {}',
    ].join('\n');
    expect(find(content, 'do_thing')?.kind).toBe('function');
    expect(find(content, 'Point')?.kind).toBe('struct');
    expect(find(content, 'Color')?.kind).toBe('enum');
    expect(find(content, 'Draw')?.kind).toBe('trait');
    expect(find(content, 'Alias')?.kind).toBe('type');
    expect(find(content, 'MAX')?.kind).toBe('const');
    expect(find(content, 'GLOBAL')?.kind).toBe('static');
    expect(find(content, 'utils')?.kind).toBe('mod');
  });

  it('classifies an impl block as kind "impl"', () => {
    forceRegex();
    // Name distinct from any struct/enum so dedup-by-name doesn't mask the impl.
    expect(find('impl Renderer {}', 'Renderer')?.kind).toBe('impl');
  });

  it('deduplicates symbols sharing name + line', () => {
    forceRegex();
    // Two `fn foo` on the same physical line → one survives after dedup.
    const res = parse('fn foo() {} fn foo() {}');
    expect(res.symbols.filter((s) => s.name === 'foo')).toHaveLength(1);
  });
});

describe('rs-parser native (syn) path', () => {
  it('returns native symbols when rustc + cargo + syn-parser succeed', () => {
    execFileSyncMock.mockReturnValue(''); // rustc --version and cargo metadata both ok
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { name: 'native_fn', kind: 'function', line: 1, col: 0, signature: 'fn native_fn()' },
      ]),
    });
    const res = parse('fn native_fn() {}');
    expect(res.symbols).toHaveLength(1);
    expect(res.symbols[0]?.name).toBe('native_fn');
    expect(res.symbols[0]?.lang).toBe('rs');
  });

  it('falls back to regex when cargo metadata is missing', () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'cargo' && args[0] === 'metadata') throw new Error('no cargo project');
      return '';
    });
    // regex path still extracts the struct
    expect(find('struct OnlyRegex {}', 'OnlyRegex')?.kind).toBe('struct');
  });

  it('falls back to regex when the native run exits non-zero', () => {
    execFileSyncMock.mockReturnValue('');
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
    expect(find('struct FromRegex {}', 'FromRegex')?.kind).toBe('struct');
  });

  it('falls back to regex when the native run throws', () => {
    execFileSyncMock.mockReturnValue('');
    spawnSyncMock.mockImplementation(() => {
      throw new Error('cargo run failed');
    });
    expect(find('enum E {}', 'E')?.kind).toBe('enum');
  });
});
