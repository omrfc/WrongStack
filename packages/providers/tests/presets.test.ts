import { describe, expect, it } from 'vitest';
import { PRESETS, type PresetSpec, listPresets } from '../src/presets.js';

describe('presets (deprecated)', () => {
  it('PRESETS is empty', () => expect(PRESETS).toEqual({}));
  it('listPresets returns empty array', () => expect(listPresets()).toEqual([]));
  it('PresetSpec is never', () => {
    const val: PresetSpec = undefined as never;
    expect(val).toBeUndefined();
  });
});
