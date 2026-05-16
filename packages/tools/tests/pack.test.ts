import { describe, expect, it } from 'vitest';
import { builtinTools } from '../src/builtin.js';
import { builtinToolsPack } from '../src/pack.js';

describe('builtinToolsPack', () => {
  it('exposes the built-in tools as a WrongStack pack', () => {
    expect(builtinToolsPack.name).toBe('builtin-tools');
    expect(builtinToolsPack.tools).toBe(builtinTools);
    expect(builtinToolsPack.tools?.length).toBeGreaterThan(20);
  });
});
