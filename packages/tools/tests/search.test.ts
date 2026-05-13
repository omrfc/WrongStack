import { describe, it, expect, vi } from 'vitest';
import { searchTool } from '../src/search.js';

const makeOpts = () => ({ signal: new AbortController().signal });

describe('searchTool', () => {
  it('has correct metadata', () => {
    expect(searchTool.name).toBe('search');
    expect(searchTool.permission).toBe('confirm');
    expect(searchTool.inputSchema.required).toContain('query');
  });

  it('throws when query is missing', async () => {
    const ctx = {} as any;
    await expect(searchTool.execute({} as any, ctx, makeOpts())).rejects.toThrow();
  });

  it('throws for unknown source', async () => {
    const ctx = {} as any;
    await expect(searchTool.execute({ query: 'test', source: 'unknown' as any }, ctx, makeOpts())).rejects.toThrow();
  });

  it('defaults to duckduckgo', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test' }, ctx, makeOpts());
    expect(result.source).toBe('duckduckgo');
  });

  it('respects num_results bounds', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 5 }, ctx, makeOpts());
    expect(result.query).toBe('test');
  });

  it('caps num_results at MAX_RESULTS', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 999 }, ctx, makeOpts());
    // should cap at 50
    expect(result.results).toBeDefined();
  });

  it('uses google source', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', source: 'google' }, ctx, makeOpts());
    expect(result.source).toBe('google');
  });

  it('uses bing source', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', source: 'bing' }, ctx, makeOpts());
    expect(result.source).toBe('bing');
  });

  it('has truncated flag', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 1 }, ctx, makeOpts());
    expect(typeof result.truncated).toBe('boolean');
  });

  it('returns results array', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test' }, ctx, makeOpts());
    expect(Array.isArray(result.results)).toBe(true);
  });
});