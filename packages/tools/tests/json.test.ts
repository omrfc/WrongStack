import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { jsonTool } from '../src/json.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-tool-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('jsonTool', () => {
  it('has correct metadata', () => {
    expect(jsonTool.name).toBe('json');
    expect(jsonTool.permission).toBe('auto');
    expect(jsonTool.mutating).toBe(false);
  });

  it('returns error when no file or data provided', async () => {
    const result = await jsonTool.execute({});
    expect(result.error).toBe('Provide file or data');
  });

  it('parses valid JSON from data', async () => {
    const result = await jsonTool.execute({ data: '{"foo":123}' });
    expect(result.data).toEqual({ foo: 123 });
    expect(result.type).toBe('object');
    expect(result.error).toBeUndefined();
  });

  it('returns parse error for invalid JSON', async () => {
    const result = await jsonTool.execute({ data: '{invalid}' });
    expect(result.error).toContain('Parse failed');
    expect(result.data).toBeNull();
  });

  it('reads from file', async () => {
    await fs.writeFile(path.join(tmpDir, 'test.json'), '{"a":1}', 'utf8');
    const result = await jsonTool.execute({ file: path.join(tmpDir, 'test.json') });
    expect(result.data).toEqual({ a: 1 });
  });

  it('returns error for non-existent file', async () => {
    const result = await jsonTool.execute({ file: '/nonexistent.json' });
    expect(result.error).toContain('Could not read file');
  });

  it('extracts keys', async () => {
    const result = await jsonTool.execute({ data: '{"foo":1,"bar":2}' });
    expect(result.keys).toContain('foo');
    expect(result.keys).toContain('bar');
  });

  it('handles array type', async () => {
    const result = await jsonTool.execute({ data: '[1,2,3]' });
    expect(result.type).toBe('array');
    expect(result.data).toEqual([1, 2, 3]);
  });

  it('validates without full output', async () => {
    const result = await jsonTool.execute({ data: '{"valid":true}', validate: true });
    expect(result.formatted).toBe('valid');
  });

  it('queries nested paths', async () => {
    const result = await jsonTool.execute({ data: '{"a":{"b":[1,2,3]}}', query: 'a.b[0]' });
    expect(result.query_result).toBe(1);
  });

  it('queries array index', async () => {
    const result = await jsonTool.execute({ data: '[10,20,30]', query: '1' });
    expect(result.query_result).toBe(20);
  });

  it('returns undefined for missing query path', async () => {
    const result = await jsonTool.execute({ data: '{"a":1}', query: 'b.c' });
    expect(result.query_result).toBeUndefined();
  });

  it('outputs as json5 format', async () => {
    const result = await jsonTool.execute({ data: '{"a":1}', format: 'json5' });
    expect(result.formatted).toBe('{\n  "a": 1\n}');
  });

  it('outputs as yaml format', async () => {
    const result = await jsonTool.execute({ data: '{"a":1}', format: 'yaml' });
    expect(result.formatted).toContain('a:');
  });

  it('handles array in yaml', async () => {
    const result = await jsonTool.execute({ data: '[1,2,3]', format: 'yaml' });
    expect(result.formatted).toContain('- 1');
  });
});