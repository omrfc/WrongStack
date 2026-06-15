import { beforeEach, describe, expect, it, vi } from 'vitest';
import jsonPathPlugin from '../src/json-path';

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

let tools: Record<string, Tool>;

beforeEach(() => {
  tools = {};
  const api = {
    tools: { register: (t: Tool) => { tools[t.name] = t; } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { extensions: {} },
  };
  jsonPathPlugin.setup(api as never);
});

const query = (data: unknown, q: string) => tools.jmespath_query!.execute({ data, query: q });

describe('jmespath_query', () => {
  it('returns the whole document for @, $ and empty query', async () => {
    const data = { a: 1 };
    expect((await query(data, '@')).result).toEqual(data);
    expect((await query(data, '$')).result).toEqual(data);
    expect((await query(data, '')).result).toEqual(data);
  });

  it('resolves dot notation including nested and missing keys', async () => {
    expect((await query({ a: 1 }, 'a')).result).toBe(1);
    expect((await query({ a: { b: 2 } }, 'a.b')).result).toBe(2);
    expect((await query({ a: null }, 'a.b')).result).toBeUndefined();
  });

  it('resolves array indexing', async () => {
    expect((await query([10, 20], '[0]')).result).toBe(10);
    expect((await query([{ x: 5 }], '[0].x')).result).toBe(5);
    expect((await query([], '[3]')).result).toBeUndefined();
  });

  it('handles the [*] wildcard for arrays and non-arrays', async () => {
    expect((await query([1, 2], '[*]')).result).toEqual([1, 2]);
    expect((await query({ a: 1 }, '[*]')).result).toEqual({ a: 1 });
  });

  it('handles multi-select projections', async () => {
    expect((await query({ items: [1, 2] }, 'items[*]')).result).toEqual([1, 2]);
    expect((await query({ items: [{ v: 1 }, { v: 2 }] }, 'items[*].v')).result).toEqual([1, 2]);
    expect((await query({ items: 'nope' }, 'items[*]')).result).toEqual([]);
  });

  it('applies filter expressions across all operators', async () => {
    const arr = [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect((await query(arr, '[n==`2`]')).result).toEqual([{ n: 2 }]);
    expect((await query(arr, '[n!=`2`]')).result).toEqual([{ n: 1 }, { n: 3 }]);
    expect((await query(arr, '[n>`2`]')).result).toEqual([{ n: 3 }]);
    expect((await query(arr, '[n<`2`]')).result).toEqual([{ n: 1 }]);
    expect((await query(arr, '[n>=`2`]')).result).toEqual([{ n: 2 }, { n: 3 }]);
    expect((await query(arr, '[n<=`2`]')).result).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('filters by a quoted-string literal and projects the rest', async () => {
    const arr = [{ name: 'a', role: 'admin' }, { name: 'b', role: 'user' }];
    expect((await query(arr, '[role==`"admin"`].name')).result).toEqual(['a']);
  });

  it('returns [] when filtering a non-array', async () => {
    expect((await query({ not: 'array' }, '[n==`1`]')).result).toEqual([]);
  });

  it('supports length/keys/values/type functions', async () => {
    expect((await query([1, 2, 3], 'length(@)')).result).toBe(3);
    expect((await query('hello', 'length(@)')).result).toBe(5);
    expect((await query({ a: 1, b: 2 }, 'length(@)')).result).toBe(2);
    expect((await query(42, 'length(@)')).result).toBe(0);
    expect((await query({ a: 1, b: 2 }, 'keys(@)')).result).toEqual(['a', 'b']);
    expect((await query([1], 'keys(@)')).result).toEqual([]);
    expect((await query({ a: 1 }, 'values(@)')).result).toEqual([1]);
    expect((await query([1], 'values(@)')).result).toEqual([]);
    expect((await query(null, 'type(@)')).result).toBe('null');
    expect((await query([1], 'type(@)')).result).toBe('array');
    expect((await query('x', 'type(@)')).result).toBe('string');
  });

  it('returns null for an unmatched query', async () => {
    expect((await query({ a: 1 }, 'foo bar baz')).result).toBeNull();
  });

  it('reports resultType for null and array results', async () => {
    expect((await query({ a: null }, 'a')).resultType).toBe('null');
    expect((await query([1], '[*]')).resultType).toBe('array');
  });

  it('returns ok:false when the filter literal is not valid JSON', async () => {
    // single-quoted literal → JSON.parse('value') throws inside the filter path
    const res = await query([{ x: 1 }], "[x=='value']");
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});

describe('json_validate', () => {
  const validate = (data: unknown, schema: unknown) => tools.json_validate!.execute({ data, schema });

  it('validates integer / type matches and mismatches', async () => {
    expect((await validate(5, { type: 'integer' })).valid).toBe(true);
    expect((await validate(5.5, { type: 'integer' })).valid).toBe(false);
    expect((await validate('x', { type: 'string' })).valid).toBe(true);
    expect((await validate('x', { type: 'number' })).valid).toBe(false);
  });

  it('reports array and null actual types on a mismatch', async () => {
    const arr = await validate([1, 2], { type: 'string' });
    expect((arr.errors as string[])[0]).toMatch(/got array/);
    const nul = await validate(null, { type: 'string' });
    expect((nul.errors as string[])[0]).toMatch(/got null/);
  });

  it('validates uri format', async () => {
    expect((await validate('https://example.com', { type: 'string', format: 'uri' })).valid).toBe(true);
    const bad = await validate(':::not a uri', { type: 'string', format: 'uri' });
    expect(bad.valid).toBe(false);
    expect((bad.errors as string[])[0]).toMatch(/not a valid URI/);
  });

  it('validates pattern, min/max length and min/max number', async () => {
    expect((await validate('abc', { type: 'string', pattern: '^a' })).valid).toBe(true);
    expect((await validate('xyz', { type: 'string', pattern: '^a' })).valid).toBe(false);
    expect((await validate('a', { type: 'string', minLength: 2 })).valid).toBe(false);
    expect((await validate('abcd', { type: 'string', maxLength: 2 })).valid).toBe(false);
    expect((await validate(1, { type: 'number', minimum: 5 })).valid).toBe(false);
    expect((await validate(9, { type: 'number', maximum: 5 })).valid).toBe(false);
  });

  it('walks array items when items is a tuple schema array', async () => {
    // The validator only descends into array items when `items` is itself an
    // array (tuple-style); it iterates each element through check().
    const arrRes = await validate([1, 2], { type: 'array', items: [{ type: 'number' }] });
    expect(arrRes.ok).toBe(true);
    expect(arrRes.valid).toBe(true);
  });

  it('validates nested object properties recursively', async () => {
    const objRes = await validate({ a: 'x' }, { type: 'object', properties: { a: { type: 'number' } } });
    expect(objRes.valid).toBe(false);
    expect((objRes.errors as string[]).some((e) => e.includes('$.a'))).toBe(true);
  });

  it('returns ok:false when the schema pattern is an invalid regex', async () => {
    const res = await validate('x', { type: 'string', pattern: '[' });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});

describe('json_transform', () => {
  it('applies transforms in sequence and records each step', async () => {
    const res = await tools.json_transform!.execute({
      data: { items: [{ v: 1 }, { v: 2 }] },
      transforms: ['items[*].v', 'length(@)'],
    });
    expect(res.ok).toBe(true);
    expect(res.finalResult).toBe(2);
    expect((res.steps as unknown[]).length).toBe(2);
  });

  it('returns ok:false when a transform throws', async () => {
    const res = await tools.json_transform!.execute({
      data: [{ x: 1 }],
      transforms: ["[x=='bad']"],
    });
    expect(res.ok).toBe(false);
  });
});

describe('json_merge', () => {
  it('deep-merges nested objects (patch keys win on scalar collisions)', async () => {
    const res = await tools.json_merge!.execute({
      base: { a: 1, nested: { x: 1 } },
      patch: { a: 2, nested: { y: 2 } },
    });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ a: 2, nested: { x: 1, y: 2 } });
  });

  it('merges disjoint keys', async () => {
    const res = await tools.json_merge!.execute({ base: { a: 1 }, patch: { b: 2 } });
    expect(res.result).toEqual({ a: 1, b: 2 });
  });

  it('prefer-base keeps the base when a whole side is scalar', async () => {
    const res = await tools.json_merge!.execute({ base: 5, patch: 10, conflictResolution: 'prefer-base' });
    expect(res.ok).toBe(true);
    expect(res.result).toBe(5);
  });

  it('prefer-patch (default) takes the patch for a scalar collision', async () => {
    const res = await tools.json_merge!.execute({ base: 5, patch: 10 });
    expect(res.result).toBe(10);
  });

  it('returns ok:false when the merge throws (circular references)', async () => {
    const base: Record<string, unknown> = {};
    base.loop = base;
    const patch: Record<string, unknown> = {};
    patch.loop = patch;
    const res = await tools.json_merge!.execute({ base, patch });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});
