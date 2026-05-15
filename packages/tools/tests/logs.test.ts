import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logsTool } from '../src/logs.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logs-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('logsTool', () => {
  it('has correct metadata', () => {
    expect(logsTool.name).toBe('logs');
    expect(logsTool.permission).toBe('confirm');
    expect(logsTool.mutating).toBe(false);
  });

  it('returns none when no service or path provided', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({}, ctx, makeOpts());
    expect(result.source).toBe('none');
    expect(result.entries).toEqual([]);
  });

  it('handles service param (docker)', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp' }, ctx, makeOpts());
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('entries');
  });

  it('handles lines default', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp' }, ctx, makeOpts());
    expect(result).toHaveProperty('total');
  });

  it('returns entries for service docker', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp' }, ctx, makeOpts());
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('total');
  });

  it('handles stream param for service', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp', stream: true }, ctx, makeOpts());
    expect(result).toHaveProperty('stream_mode');
  });

  it('handles filter for service', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp', filter: 'error' }, ctx, makeOpts());
    expect(result).toHaveProperty('total');
  });

  it('handles since for service', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp', since: '1h' }, ctx, makeOpts());
    expect(result).toHaveProperty('total');
  });

  it('handles stream param for file path', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    await fs.writeFile(filePath, '2024-01-01 INFO hello\n2024-01-02 ERROR world', 'utf8');
    const ctx = makeCtx();
    const result = await logsTool.execute({ path: 'app.log', stream: true }, ctx, makeOpts());
    expect(result.stream_mode).toBe(true);
  });

  it('handles filter for file path', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    await fs.writeFile(filePath, '2024-01-01 INFO hello\n2024-01-02 ERROR world', 'utf8');
    const ctx = makeCtx();
    const result = await logsTool.execute({ path: 'app.log', filter: 'ERROR' }, ctx, makeOpts());
    expect(result).toHaveProperty('total');
  });

  it('parses log entries from file', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    await fs.writeFile(filePath, '2024-01-01 INFO hello\n2024-01-02 ERROR world', 'utf8');
    const ctx = makeCtx();
    const result = await logsTool.execute({ path: 'app.log' }, ctx, makeOpts());
    expect(result.entries.length).toBeGreaterThan(0);
  });
});
