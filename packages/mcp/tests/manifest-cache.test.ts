import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MCPTool } from '../src/client.js';
import { manifestConfigHash, readManifest, writeManifest } from '../src/manifest-cache.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manifest-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const tools: MCPTool[] = [
  { name: 'a', description: 'A', inputSchema: { type: 'object', properties: {} } },
  { name: 'b', inputSchema: { type: 'object', properties: {} } },
];

describe('manifestConfigHash', () => {
  it('is stable for the same connection fields', () => {
    const a = manifestConfigHash({ transport: 'stdio', command: 'npx', args: ['-y', 'x'] });
    const b = manifestConfigHash({ transport: 'stdio', command: 'npx', args: ['-y', 'x'] });
    expect(a).toBe(b);
  });

  it('changes when command/args/url/transport change', () => {
    const base = manifestConfigHash({ transport: 'stdio', command: 'npx', args: ['x'] });
    expect(manifestConfigHash({ transport: 'stdio', command: 'npx', args: ['y'] })).not.toBe(base);
    expect(manifestConfigHash({ transport: 'sse', url: 'https://x' })).not.toBe(base);
  });
});

describe('readManifest / writeManifest', () => {
  it('round-trips tools when the hash matches', async () => {
    const hash = manifestConfigHash({ transport: 'stdio', command: 'npx' });
    await writeManifest(tmp, 'svc', hash, tools);
    const read = await readManifest(tmp, 'svc', hash);
    expect(read).toEqual(tools);
  });

  it('returns null when the config hash no longer matches (stale)', async () => {
    await writeManifest(tmp, 'svc', 'OLD', tools);
    expect(await readManifest(tmp, 'svc', 'NEW')).toBeNull();
  });

  it('returns null when there is no cache', async () => {
    expect(await readManifest(tmp, 'missing', 'h')).toBeNull();
  });

  it('sanitizes unsafe server names into the file path', async () => {
    const hash = 'h';
    await writeManifest(tmp, 'we/ird:name', hash, tools);
    // Stored under a sanitized file name; read finds it by the same name.
    expect(await readManifest(tmp, 'we/ird:name', hash)).toEqual(tools);
  });
});
