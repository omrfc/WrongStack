import { describe, expect, it } from 'vitest';
import { applyTextEdits } from '../../src/tools/workspace-edit.js';

describe('applyTextEdits', () => {
  it('applies edits from bottom to top', () => {
    const out = applyTextEdits('one\ntwo\nthree\n', [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: 'ONE',
      },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
        newText: 'THREE',
      },
    ]);
    expect(out).toBe('ONE\ntwo\nTHREE\n');
  });
});
