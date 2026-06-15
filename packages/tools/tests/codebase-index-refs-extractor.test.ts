import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: (...a: unknown[]) => unlinkSyncMock(...a),
}));

import { extractRefs } from '../src/codebase-index/refs-extractor.js';

beforeEach(() => {
  execFileSyncMock.mockReset();
  unlinkSyncMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('extractRefs language dispatch', () => {
  it('returns [] for TS/JS-family languages (handled by ts-parser)', async () => {
    for (const lang of ['ts', 'tsx', 'js', 'jsx'] as const) {
      expect(await extractRefs({ file: 'a.ts', content: 'x', lang })).toEqual([]);
    }
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('returns [] for unsupported languages', async () => {
    expect(await extractRefs({ file: 'a.json', content: '{}', lang: 'json' })).toEqual([]);
  });
});

describe('extractRefs go', () => {
  it('parses go runner JSON output into Ref[]', async () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify([{ toName: 'fmt.Println', callType: 'call', line: 3 }]),
    );
    const refs = await extractRefs({ file: 'main.go', content: '', lang: 'go' });
    expect(refs).toEqual([{ fromId: 0, toName: 'fmt.Println', callType: 'call', line: 3 }]);
  });

  it('returns [] when the runner emits empty output', async () => {
    execFileSyncMock.mockReturnValue('   ');
    expect(await extractRefs({ file: 'main.go', content: '', lang: 'go' })).toEqual([]);
  });

  it('returns [] when the runner output is not valid JSON', async () => {
    execFileSyncMock.mockReturnValue('not json');
    expect(await extractRefs({ file: 'main.go', content: '', lang: 'go' })).toEqual([]);
  });

  it('returns [] (and swallows unlink errors) when the runner throws', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('go not installed');
    });
    unlinkSyncMock.mockImplementation(() => {
      throw new Error('unlink failed');
    });
    expect(await extractRefs({ file: 'main.go', content: '', lang: 'go' })).toEqual([]);
  });
});

describe('extractRefs python', () => {
  it('parses python runner JSON output into Ref[]', async () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify([{ toName: 'os.path', callType: 'import', line: 1 }]),
    );
    const refs = await extractRefs({ file: 'a.py', content: '', lang: 'py' });
    expect(refs).toEqual([{ fromId: 0, toName: 'os.path', callType: 'import', line: 1 }]);
  });

  it('returns [] on empty python output', async () => {
    execFileSyncMock.mockReturnValue('');
    expect(await extractRefs({ file: 'a.py', content: '', lang: 'py' })).toEqual([]);
  });

  it('returns [] when the python runner throws', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('python missing');
    });
    expect(await extractRefs({ file: 'a.py', content: '', lang: 'py' })).toEqual([]);
  });
});
