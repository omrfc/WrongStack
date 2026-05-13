import { describe, it, expect } from 'vitest';
import { Pipeline } from '../../src/kernel/pipeline.js';

describe('Pipeline', () => {
  it('runs empty input unchanged', async () => {
    const p = new Pipeline<number>();
    expect(await p.run(1)).toBe(1);
  });

  it('chains middleware in order', async () => {
    const p = new Pipeline<number>();
    p.use({ name: 'plus1', handler: async (v, next) => next(v + 1) });
    p.use({ name: 'times2', handler: async (v, next) => next(v * 2) });
    expect(await p.run(1)).toBe(4);
  });

  it('respects prepend', async () => {
    const p = new Pipeline<number>();
    p.use({ name: 'times2', handler: async (v, next) => next(v * 2) });
    p.prepend({ name: 'plus1', handler: async (v, next) => next(v + 1) });
    expect(await p.run(1)).toBe(4);
  });

  it('insertBefore and insertAfter', async () => {
    const p = new Pipeline<number>();
    p.use({ name: 'a', handler: async (v, n) => n(v + 1) });
    p.use({ name: 'c', handler: async (v, n) => n(v + 10) });
    p.insertAfter('a', { name: 'b', handler: async (v, n) => n(v + 100) });
    p.insertBefore('c', { name: 'b2', handler: async (v, n) => n(v + 1000) });
    expect(p.list()).toEqual(['a', 'b', 'b2', 'c']);
  });

  it('insertAt at arbitrary index', async () => {
    const p = new Pipeline<number>();
    p.use({ name: 'a', handler: async (v, n) => n(v + 1) });
    p.use({ name: 'b', handler: async (v, n) => n(v + 10) });
    p.use({ name: 'c', handler: async (v, n) => n(v + 100) });
    p.insertAt(1, { name: 'x', handler: async (v, n) => n(v + 1000) });
    expect(p.list()).toEqual(['a', 'x', 'b', 'c']);
    expect(await p.run(0)).toBe(1111);
  });

  it('insertAt clamps out-of-range indices', async () => {
    const p = new Pipeline<number>();
    p.use({ name: 'a', handler: async (v, n) => n(v + 1) });
    p.use({ name: 'b', handler: async (v, n) => n(v + 10) });
    p.insertAt(99, { name: 'c', handler: async (v, n) => n(v + 100) });
    expect(p.list()).toEqual(['a', 'b', 'c']);
    p.insertAt(-5, { name: 'd', handler: async (v, n) => n(v + 1000) });
    expect(p.list()).toEqual(['d', 'a', 'b', 'c']);
  });

  it('replace and remove', async () => {
    const p = new Pipeline<number>();
    p.use({ name: 'a', handler: async (v, n) => n(v + 1) });
    p.use({ name: 'b', handler: async (v, n) => n(v + 2) });
    p.replace('a', { name: 'a', handler: async (v, n) => n(v + 100) });
    p.remove('b');
    expect(await p.run(0)).toBe(100);
  });

  it('rejects duplicate names', () => {
    const p = new Pipeline<number>();
    p.use({ name: 'x', handler: async (v, n) => n(v) });
    expect(() => p.use({ name: 'x', handler: async (v, n) => n(v) })).toThrow(/already/);
  });

  it('throws for unknown insertBefore target', () => {
    const p = new Pipeline<number>();
    expect(() =>
      p.insertBefore('missing', { name: 'x', handler: async (v, n) => n(v) }),
    ).toThrow(/not found/);
  });

  it('propagates middleware throw', async () => {
    const p = new Pipeline<number>();
    p.use({
      name: 'fail',
      handler: async () => {
        throw new Error('boom');
      },
    });
    await expect(p.run(0)).rejects.toThrow('boom');
  });

  it('async order preserved', async () => {
    const p = new Pipeline<string>();
    const order: string[] = [];
    p.use({
      name: 'a',
      handler: async (v, n) => {
        order.push('a-before');
        const r = await n(`${v}A`);
        order.push('a-after');
        return r;
      },
    });
    p.use({
      name: 'b',
      handler: async (v, n) => {
        order.push('b-before');
        const r = await n(`${v}B`);
        order.push('b-after');
        return r;
      },
    });
    expect(await p.run('')).toBe('AB');
    expect(order).toEqual(['a-before', 'b-before', 'b-after', 'a-after']);
  });
});
