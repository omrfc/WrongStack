import { describe, expect, it } from 'vitest';
import { Container, type Token } from '../../src/kernel/container.js';

interface Logger {
  msg: string;
}

const LOGGER: Token<Logger> = Symbol('Logger') as Token<Logger>;
const COUNTER: Token<{ count: number }> = Symbol('Counter') as Token<{ count: number }>;

describe('Container', () => {
  it('binds and resolves', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'hi' }));
    expect(c.resolve(LOGGER).msg).toBe('hi');
  });

  it('rejects double bind', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'a' }));
    expect(() => c.bind(LOGGER, () => ({ msg: 'b' }))).toThrow(/already bound/);
  });

  it('rejects override of unbound', () => {
    const c = new Container();
    expect(() => c.override(LOGGER, () => ({ msg: 'a' }))).toThrow(/not bound/);
  });

  it('override replaces and clears cache', () => {
    const c = new Container();
    let count = 0;
    c.bind(LOGGER, () => ({ msg: `v${++count}` }));
    expect(c.resolve(LOGGER).msg).toBe('v1');
    expect(c.resolve(LOGGER).msg).toBe('v1'); // cached
    c.override(LOGGER, () => ({ msg: 'new' }));
    expect(c.resolve(LOGGER).msg).toBe('new');
  });

  it('singleton: default true', () => {
    const c = new Container();
    let count = 0;
    c.bind(COUNTER, () => ({ count: ++count }));
    expect(c.resolve(COUNTER)).toBe(c.resolve(COUNTER));
  });

  it('singleton: false makes new each time', () => {
    const c = new Container();
    let count = 0;
    c.bind(COUNTER, () => ({ count: ++count }), { singleton: false });
    expect(c.resolve(COUNTER)).not.toBe(c.resolve(COUNTER));
  });

  it('decorate wraps and stacks', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'base' }));
    c.decorate(LOGGER, (inner) => ({ msg: `(${inner.msg})` }));
    c.decorate(LOGGER, (inner) => ({ msg: `[${inner.msg}]` }));
    expect(c.resolve(LOGGER).msg).toBe('[(base)]');
  });

  it('rejects decorate of unbound', () => {
    const c = new Container();
    expect(() => c.decorate(LOGGER, (i) => i)).toThrow(/not bound/);
  });

  it('resolve of unbound throws with description', () => {
    const c = new Container();
    expect(() => c.resolve(LOGGER)).toThrow(/Logger/);
  });

  it('has() reports binding state', () => {
    const c = new Container();
    expect(c.has(LOGGER)).toBe(false);
    c.bind(LOGGER, () => ({ msg: 'x' }));
    expect(c.has(LOGGER)).toBe(true);
  });

  it('ownerOf tracks owner with decoration', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'x' }), { owner: 'core' });
    c.decorate(LOGGER, (i) => i, 'plugin-a');
    expect(c.ownerOf(LOGGER)).toMatch(/core\+plugin-a/);
  });

  it('unbind removes a binding and returns true; false for unknown', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'x' }));
    expect(c.has(LOGGER)).toBe(true);
    expect(c.unbind(LOGGER)).toBe(true);
    expect(c.has(LOGGER)).toBe(false);
    expect(c.unbind(LOGGER)).toBe(false);
    expect(() => c.resolve(LOGGER)).toThrow(/not bound/);
  });

  it('unbind discards decorators stacked on the token', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'base' }));
    c.decorate(LOGGER, (i) => ({ msg: `${i.msg}+dec` }));
    expect(c.resolve(LOGGER).msg).toBe('base+dec');
    c.unbind(LOGGER);
    // Re-bind: should NOT inherit the previous decorator chain.
    c.bind(LOGGER, () => ({ msg: 'fresh' }));
    expect(c.resolve(LOGGER).msg).toBe('fresh');
  });

  it('clear drops every binding', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'a' }));
    c.bind(COUNTER, () => ({ count: 0 }));
    expect(c.list()).toHaveLength(2);
    c.clear();
    expect(c.list()).toHaveLength(0);
    expect(c.has(LOGGER)).toBe(false);
  });

  it('inspect returns decorator count + cache state', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'x' }), { owner: 'core' });
    expect(c.inspect(LOGGER)).toEqual({
      owner: 'core',
      singleton: true,
      decoratorCount: 0,
      cached: false,
    });
    c.decorate(LOGGER, (i) => i, 'plug');
    c.resolve(LOGGER);
    const after = c.inspect(LOGGER)!;
    expect(after.decoratorCount).toBe(1);
    expect(after.cached).toBe(true);
    expect(c.inspect(COUNTER)).toBeNull();
  });
});
