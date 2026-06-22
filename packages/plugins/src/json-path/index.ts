import { expectDefined, deepMerge as deepMergeCore } from '@wrongstack/core';
/**
 * json-path plugin — JMESPath query, validate, and transform JSON/YAML.
 *
 * Tools registered:
 * - jmespath_query: Execute JMESPath query on JSON/YAML data
 * - json_validate: Validate data against a JSON Schema
 * - json_transform: Apply JMESPath transforms to data
 * - json_merge: Deep merge two JSON objects
 */
import type { Plugin } from '@wrongstack/core';
const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Minimal JMESPath implementation (simple subset)
// ---------------------------------------------------------------------------

function jmespathSearch(data: unknown, query: string): unknown {
  // Handle basic JMESPath expressions
  if (!query || query === '@') return data;

  // Root access
  if (query === '$') return data;

  // Dot notation: foo.bar
  const dotMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\.(.+))?$/);
  if (dotMatch) {
    const key = expectDefined(dotMatch[1]);
    const rest = dotMatch[2];
    const val = (data as Record<string, unknown>)?.[key];
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  // Array access: [0]
  const arrMatch = query.match(/^\[(\d+)\](?:\.(.+))?$/);
  if (arrMatch) {
    const idx = Number.parseInt(expectDefined(arrMatch[1]), 10);
    const rest = arrMatch[2];
    const arr = data as unknown[];
    const val = arr?.[idx];
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  // Wildcard: [*]
  if (query === '[*]') {
    if (Array.isArray(data)) {
      return data;
    }
    return data;
  }

  // Multi-select: foo.bar[*].baz
  const multiMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[\*\](?:\.(.+))?$/);
  if (multiMatch) {
    const key = expectDefined(multiMatch[1]);
    const rest = multiMatch[2];
    const arr = (data as Record<string, unknown[]>)?.[key];
    if (!Array.isArray(arr)) return [];
    if (rest === undefined) return arr;
    return arr.map((item) => jmespathSearch(item, rest));
  }

  // Filter: [?foo==`bar`]
  const filterMatch = query.match(/^\[\\?([a-zA-Z_][a-zA-Z0-9_]*)(==|!=|<|>|<=|>=)(`[^`]+`|'[^']*')\](?:\.(.+))?$/);
  if (filterMatch) {
    const field = expectDefined(filterMatch[1]);
    const op = expectDefined(filterMatch[2]);
    const rawVal = expectDefined(filterMatch[3]);
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
        /* v8 ignore next -- op is constrained to the six operators by the filter regex; default is unreachable. */
        default: return true;
      }
    });
    if (rest === undefined) return filtered;
    return filtered.map((item) => jmespathSearch(item, rest));
  }

  // Function calls: length(@)
  const fnMatch = query.match(/^(length|keys|values|type)\(@\)$/);
  if (fnMatch) {
    const fn = expectDefined(fnMatch[1]);
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
      /* v8 ignore next 2 -- fn is constrained to the four names by the function regex; default is unreachable. */
      default:
        return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSON Schema validator (simplified)
// ---------------------------------------------------------------------------

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
// Deep merge — delegates to @wrongstack/core's shared utility.
// ---------------------------------------------------------------------------

function deepMerge(base: unknown, patch: unknown, conflictResolution: 'prefer-base' | 'prefer-patch' = 'prefer-patch'): unknown {
  return deepMergeCore(base, patch, { conflictResolution });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'json-path',
  version: '0.1.0',
  description: 'JMESPath query, JSON Schema validation, transformation, and deep merge for JSON/YAML',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    strictValidation: false,
    maxDepth: 50,
    allowLargeFiles: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      strictValidation: { type: 'boolean', default: false },
      maxDepth: { type: 'number', default: 50 },
      allowLargeFiles: { type: 'boolean', default: false },
    },
  },

  setup(api) {
    // --- jmespath_query ---
    api.tools.register({
      name: 'jmespath_query',
      description: 'Execute a JMESPath query on JSON or YAML data. Supports dot notation, array indexing, wildcards, filters, and functions.',
      inputSchema: {
        type: 'object',
        properties: {
          data: { description: 'JSON/YAML data to query (object or array)' },
          query: { type: 'string', description: 'JMESPath query expression' },
        },
        required: ['data', 'query'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const data = input['data'] as unknown;
        const query = input['query'] as string;

        try {
          const result = jmespathSearch(data, query);
          return {
            ok: true,
            query,
            result,
            resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
          };
        } catch (err: unknown) {
          return { ok: false, error: String(err), query };
        }
      },
    });

    // --- json_validate ---
    api.tools.register({
      name: 'json_validate',
      description: 'Validate JSON/YAML data against a JSON Schema. Reports all validation errors found.',
      inputSchema: {
        type: 'object',
        properties: {
          data: { description: 'JSON data to validate' },
          schema: { description: 'JSON Schema to validate against' },
        },
        required: ['data', 'schema'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const data = input['data'] as unknown;
        const schema = input['schema'] as Record<string, unknown>;

        try {
          const { valid, errors } = validateJsonSchema(data, schema);
          return { ok: true, valid, errors, errorCount: errors.length };
        } catch (err: unknown) {
          return { ok: false, error: String(err) };
        }
      },
    });

    // --- json_transform ---
    api.tools.register({
      name: 'json_transform',
      description: 'Apply a series of JMESPath transforms to data, passing the output of each as input to the next.',
      inputSchema: {
        type: 'object',
        properties: {
          data: { description: 'Initial JSON data' },
          transforms: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of JMESPath query strings to apply in sequence',
          },
        },
        required: ['data', 'transforms'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const data = input['data'] as unknown;
        const transforms = input['transforms'] as string[];

        try {
          let current: unknown = data;
          const steps: Array<{ transform: string; result: unknown }> = [];

          for (const t of transforms) {
            current = jmespathSearch(current, t);
            steps.push({ transform: t, result: current });
          }

          return { ok: true, finalResult: current, steps };
        } catch (err: unknown) {
          return { ok: false, error: String(err) };
        }
      },
    });

    // --- json_merge ---
    api.tools.register({
      name: 'json_merge',
      description: 'Deep merge two JSON objects. Use conflictResolution to decide which value wins on collision.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { description: 'Base JSON object' },
          patch: { description: 'Patch JSON object to merge in' },
          conflictResolution: {
            type: 'string',
            enum: ['prefer-base', 'prefer-patch'],
            default: 'prefer-patch',
          },
        },
        required: ['base', 'patch'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const base = input['base'] as unknown;
        const patch = input['patch'] as unknown;
        const conflictResolution = (input['conflictResolution'] as 'prefer-base' | 'prefer-patch') ?? 'prefer-patch';

        try {
          const result = deepMerge(base, patch, conflictResolution);
          return { ok: true, result };
        } catch (err: unknown) {
          return { ok: false, error: String(err) };
        }
      },
    });

    api.log.info('json-path plugin loaded', { version: '0.1.0' });
  },
};

export default plugin;