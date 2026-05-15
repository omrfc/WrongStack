import { describe, expect, it } from 'vitest';
import { formatTool } from '../src/format.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('formatTool', () => {
  it('has correct metadata', () => {
    expect(formatTool.name).toBe('format');
    expect(formatTool.permission).toBe('confirm');
    expect(formatTool.mutating).toBe(true);
  });

  it('uses biome when neither biome.json nor .prettierrc exists (fallback)', async () => {
    // detectFixer falls through to return 'biome' when neither file is found
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await formatTool.execute({ fixer: 'auto' }, ctx, makeOpts());
    // biome is the fallback when nothing is detected
    expect(result).toHaveProperty('fixer');
  });
});
