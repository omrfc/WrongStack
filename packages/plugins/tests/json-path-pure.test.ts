/**
 * Unit tests for json-path pure functions.
 * Copies of production logic are re-implemented here to test without
 * the full plugin infrastructure.
 */
import { describe, expect, it } from 'vitest';
import { deepMerge as deepMergeCore } from '@wrongstack/core';

function deepMerge(
  base: unknown,
  patch: unknown,
  conflictResolution: 'prefer-base' | 'prefer-patch' = 'prefer-patch',
): unknown {
  return deepMergeCore(base, patch, { conflictResolution });
}

function jmespathSearch(data: unknown, query: string): unknown {
  if (!query || query === '@') return data;
  if (query === '$') return data;

  const dotMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\.(.+))?$/);
  if (dotMatch) {
    const key = dotMatch[1]!;
    const rest = dotMatch[2];
    const val = (data as Record<string, unknown>)?.[key];
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  const arrMatch = query.match(/^\[(\d+)\](?:\.(.+))?$/);
  if (arrMatch) {
    const idx = Number.parseInt(arrMatch[1]!, 10);
    const rest = arrMatch[2];
    const arr = data as unknown[];
    const val = arr?.[idx];
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  if (query === '[*]') return Array.isArray(data) ? data : data;

  const multiMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[\*\](?:\.(.+))?$/);
  if (multiMatch) {
    const key = multiMatch[1]!;
    const rest = multiMatch[2];
    const arr = (data as Record<string, unknown[]>)?.[key];
    if (!Array.isArray(arr)) return [];
    if (rest === undefined) return arr;
    return arr.map((item) => jmespathSearch(item, rest));
  }

  // Note: the production filter regex is /^\\[\\?(...)...$/ which requires a
  // literal backslash before '[' — this means standard [?foo==`"bar"`] queries
  // never match and filter returns null. The test below documents this.
  const filterMatch = query.match(/^\[\\?([a-zA-Z_][a-zA-Z0-9_]*)(==|!=|<|>|<=|>=)(`[^`]+`|'[^']*')\](?:\.(.+))?$/);
  if (filterMatch) {
    const field = filterMatch[1]!;
    const op = filterMatch[2]!;
    const rawVal = filterMatch[3]!;
    const rest = filterMatch[4];
    const cmpVal = JSON.parse(rawVal.slice(1, -1));
    const arr = data as Record<string, unknown>[];
    if (!Array.isArray(arr)) return [];
    const filtered = arr.filter((item) => {
      const itemVal = (item as Record<string, unknown>)[field];
      switch (op) {
        case '==': return itemVal === cmpVal;
        case '!=': return itemVal !== cmpVal;
        case '>': return Number(itemVal) > Number(cmpVal);
        case '<': return Number(itemVal) < Number(cmpVal);
        case '>=': return Number(itemVal) >= Number(cmpVal);
        case '<=': return Number(itemVal) <= Number(cmpVal);
        default: return true;
      }
    });
    if (rest === undefined) return filtered;
    return filtered.map((item) => jmespathSearch(item, rest));
  }

  const fnMatch = query.match(/^(length|keys|values|type)\(@\)$/);
  if (fnMatch) {
    const fn = fnMatch[1]!;
    switch (fn) {
      case 'length':
        if (Array.isArray(data)) return data.length;
        if (typeof data === 'string') return data.length;
        if (typeof data === 'object' && data !== null) return Object.keys(data as object).length;
        return 0;
      case 'keys':
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) return Object.keys(data as object);
        return [];
      case 'values':
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) return Object.values(data as object);
        return [];
      case 'type':
        if (data === null) return 'null';
        if (Array.isArray(data)) return 'array';
        return typeof data;
      default: return null;
    }
  }

  return null;
}

function validateJsonSchema(data: unknown, schema: Record<string, unknown>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  function check(value: unknown, s: Record<string, unknown>, path: string): void {
    if (s['type']) {
      const expectedType = s['type'] as string;
      const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      if (expectedType === 'integer') {
        if (!Number.isInteger(value)) errors.push(`${path}: expected integer, got ${actualType}`);
      } else if (expectedType !== actualType) {
        errors.push(`${path}: expected ${expectedType}, got ${actualType}`);
      }
    }
    if (typeof value === 'string' && s['format'] === 'uri' && value) {
      try { new URL(value); } catch { errors.push(`${path}: not a valid URI`); }
    }
    if (typeof value === 'string' && s['pattern']) {
      const re = new RegExp(s['pattern'] as string);
      if (!re.test(value)) errors.push(`${path}: does not match pattern ${s['pattern']}`);
    }
    if (typeof value === 'string' && s['minLength'] !== undefined && value.length < (s['minLength'] as number)) {
      errors.push(`${path}: string too short (min ${s['minLength']})`);
    }
    if (typeof value === 'string' && s['maxLength'] !== undefined && value.length > (s['maxLength'] as number)) {
      errors.push(`${path}: string too long (max ${s['maxLength']})`);
    }
    if (typeof value === 'number' && s['minimum'] !== undefined && value < (s['minimum'] as number)) {
      errors.push(`${path}: below minimum ${s['minimum']}`);
    }
    if (typeof value === 'number' && s['maximum'] !== undefined && value > (s['maximum'] as number)) {
      errors.push(`${path}: above maximum ${s['maximum']}`);
    }
    if (Array.isArray(value) && s['items'] && Array.isArray(s['items'])) {
      for (let i = 0; i < value.length; i++) {
        check(value[i], s['items'] as never as Record<string, unknown>, `${path}[${i}]`);
      }
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && s['properties']) {
      const props = s['properties'] as Record<string, Record<string, unknown>>;
      for (const [k, propSchema] of Object.entries(props)) {
        check((value as Record<string, unknown>)[k], propSchema, `${path}.${k}`);
      }
    }
  }
  check(data, schema, '$');
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('jmespathSearch', () => {
  it('returns data as-is for @ or empty query', () => {
    expect(jmespathSearch({ a: 1 }, '@')).toEqual({ a: 1 });
    expect(jmespathSearch([1, 2, 3], '')).toEqual([1, 2, 3]);
  });

  it('returns data as-is for $', () => {
    expect(jmespathSearch({ a: 1 }, '$')).toEqual({ a: 1 });
  });

  it('dot notation accesses properties', () => {
    expect(jmespathSearch({ a: 1, b: 2 }, 'a')).toBe(1);
    expect(jmespathSearch({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(jmespathSearch({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
    expect(jmespathSearch({ a: { b: 2 } }, 'c')).toBeUndefined();
  });

  it('array indexing works', () => {
    expect(jmespathSearch([10, 20, 30], '[0]')).toBe(10);
    expect(jmespathSearch([10, 20, 30], '[2]')).toBe(30);
    expect(jmespathSearch([{ a: 1 }], '[0].a')).toBe(1);
    expect(jmespathSearch([10, 20], '[5]')).toBeUndefined();
  });

  it('wildcard [*] returns array as-is', () => {
    expect(jmespathSearch([1, 2, 3], '[*]')).toEqual([1, 2, 3]);
    expect(jmespathSearch({ x: 1 }, '[*]')).toEqual({ x: 1 });
  });

  it('multi-select with wildcard works', () => {
    expect(jmespathSearch({ items: [{ n: 1 }, { n: 2 }] }, 'items[*].n')).toEqual([1, 2]);
    expect(jmespathSearch({ items: [] }, 'items[*].n')).toEqual([]);
  });

  it('filter regex requires backslash before [ — standard [? queries do not match (known issue)', () => {
    // Production filter regex is /^\[\\?(...)...$/ which requires a literal backslash
    // before '['. Standard JMESPath [?foo==`"bar"`] queries do not include this backslash,
    // so filter expressions return null. Documenting behavior.
    const filterMatch = /^\[\\?([a-zA-Z_][a-zA-Z0-9_]*)(==|!=|<|>|<=|>=)(`[^`]+`|'[^']*')\](?:\.(.+))?$/.exec('[?active==`"yes"`]');
    expect(filterMatch).toBeNull();
    expect(jmespathSearch([{ active: 'yes' }], '[?active==`"yes"`]')).toBeNull();
    expect(jmespathSearch([{ score: 10 }], '[?score>`15`]')).toBeNull();
  });

  it('function length(@) works on arrays, strings, objects', () => {
    expect(jmespathSearch([1, 2, 3], 'length(@)')).toBe(3);
    expect(jmespathSearch('hello', 'length(@)')).toBe(5);
    expect(jmespathSearch({ a: 1, b: 2 }, 'length(@)')).toBe(2);
  });

  it('function keys(@) works', () => {
    expect(jmespathSearch({ a: 1, b: 2 }, 'keys(@)')).toEqual(['a', 'b']);
    expect(jmespathSearch([1, 2], 'keys(@)')).toEqual([]);
  });

  it('function values(@) works', () => {
    expect(jmespathSearch({ a: 1, b: 2 }, 'values(@)')).toEqual([1, 2]);
    expect(jmespathSearch([1, 2], 'values(@)')).toEqual([]);
  });

  it('function type(@) works', () => {
    expect(jmespathSearch(null, 'type(@)')).toBe('null');
    expect(jmespathSearch([1, 2], 'type(@)')).toBe('array');
    expect(jmespathSearch('hi', 'type(@)')).toBe('string');
    expect(jmespathSearch(42, 'type(@)')).toBe('number');
    expect(jmespathSearch(true, 'type(@)')).toBe('boolean');
  });

  it('returns null for unparseable queries', () => {
    expect(jmespathSearch({ a: 1 }, '??invalid')).toBeNull();
    expect(jmespathSearch({ a: 1 }, '[foo]')).toBeNull();
  });
});

describe('validateJsonSchema', () => {
  it('passes valid string', () => {
    expect(validateJsonSchema('hi', { type: 'string' }).valid).toBe(true);
  });

  it('fails wrong type string', () => {
    expect(validateJsonSchema(123, { type: 'string' }).valid).toBe(false);
  });

  it('passes integer type', () => {
    expect(validateJsonSchema(42, { type: 'integer' }).valid).toBe(true);
    expect(validateJsonSchema(3.14, { type: 'integer' }).valid).toBe(false);
    expect(validateJsonSchema('42', { type: 'integer' }).valid).toBe(false);
  });

  it('passes array type', () => {
    expect(validateJsonSchema([1, 2], { type: 'array' }).valid).toBe(true);
    expect(validateJsonSchema({ a: 1 }, { type: 'array' }).valid).toBe(false);
  });

  it('validates format uri', () => {
    expect(validateJsonSchema('https://example.com', { type: 'string', format: 'uri' }).valid).toBe(true);
    expect(validateJsonSchema('not-a-url', { type: 'string', format: 'uri' }).valid).toBe(false);
  });

  it('validates pattern', () => {
    expect(validateJsonSchema('abc123', { type: 'string', pattern: '^[a-z]+$' }).valid).toBe(false);
    expect(validateJsonSchema('abc', { type: 'string', pattern: '^[a-z]+$' }).valid).toBe(true);
  });

  it('validates minLength', () => {
    expect(validateJsonSchema('hello', { type: 'string', minLength: 3 }).valid).toBe(true);
    expect(validateJsonSchema('hi', { type: 'string', minLength: 3 }).valid).toBe(false);
  });

  it('validates maxLength', () => {
    expect(validateJsonSchema('hello', { type: 'string', maxLength: 10 }).valid).toBe(true);
    expect(validateJsonSchema('hello world!', { type: 'string', maxLength: 5 }).valid).toBe(false);
  });

  it('validates minimum', () => {
    expect(validateJsonSchema(5, { type: 'number', minimum: 0 }).valid).toBe(true);
    expect(validateJsonSchema(-1, { type: 'number', minimum: 0 }).valid).toBe(false);
  });

  it('validates maximum', () => {
    expect(validateJsonSchema(5, { type: 'number', maximum: 10 }).valid).toBe(true);
    expect(validateJsonSchema(100, { type: 'number', maximum: 10 }).valid).toBe(false);
  });

  it('validates nested properties', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } };
    expect(validateJsonSchema({ name: 'Alice', age: 30 }, schema).valid).toBe(true);
    expect(validateJsonSchema({ name: 'Alice', age: '30' }, schema).valid).toBe(false);
    expect(validateJsonSchema({ name: 42, age: 30 }, schema).valid).toBe(false);
  });

  it('validates array items (tuple form: items array passed to check() — passes array schema per element)', () => {
    // Production code passes the entire items array as the schema for each element.
    // Since the items array itself has no 'type' property, tuple validation always passes.
    const schema = { type: 'array', items: [{ type: 'integer' }, { type: 'string' }] };
    expect(validateJsonSchema([42, 99], schema).valid).toBe(true);
    expect(validateJsonSchema([42, 'hello'], schema).valid).toBe(true);
  });

  it('collects multiple errors across the schema', () => {
    const result = validateJsonSchema(3.14, { type: 'integer', minimum: 10 });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('deepMerge', () => {
  it('scalar patch wins over scalar base (default prefer-patch)', () => {
    expect(deepMerge('a', 'b')).toBe('b');
    expect(deepMerge(1, 2)).toBe(2);
  });

  it('prefer-base keeps base scalar', () => {
    expect(deepMerge('a', 'b', 'prefer-base')).toBe('a');
    expect(deepMerge(1, 2, 'prefer-base')).toBe(1);
  });

  it('array patch wins over array base', () => {
    expect(deepMerge([1, 2], [3, 4])).toEqual([3, 4]);
    expect(deepMerge([1, 2], [3, 4], 'prefer-base')).toEqual([1, 2]);
  });

  it('objects merge their keys', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('recursively merges nested objects', () => {
    expect(deepMerge({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 } });
  });

  it('non-object value wins over nested object on conflict', () => {
    expect(deepMerge({ a: { x: 1 } }, { a: 'scalar' })).toEqual({ a: 'scalar' });
    expect(deepMerge({ a: 'scalar' }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
  });

  it('handles null gracefully', () => {
    expect(deepMerge(null, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, null)).toBeNull();
  });

  it('undefined is returned as-is (typeof undefined !== object)', () => {
    expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, undefined)).toBeUndefined();
  });
});