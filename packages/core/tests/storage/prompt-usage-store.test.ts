import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PromptUsageStore } from '../../src/storage/prompt-usage-store.js';

describe('PromptUsageStore', () => {
  let dir: string;
  let store: PromptUsageStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-usage-'));
    store = new PromptUsageStore(path.join(dir, 'prompt-usage.json'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts empty and tolerates a missing file', async () => {
    expect(await store.load()).toEqual({});
    expect(await store.get('nope')).toBeUndefined();
    expect(await store.recent()).toEqual([]);
  });

  it('record increments the count and stamps lastUsedAt', async () => {
    const a = await store.record('p1', new Date(1000).toISOString());
    expect(a).toMatchObject({ count: 1 });
    const b = await store.record('p1', new Date(2000).toISOString());
    expect(b).toMatchObject({ count: 2, lastUsedAt: new Date(2000).toISOString() });
    expect((await store.get('p1'))?.count).toBe(2);
  });

  it('recent() orders by lastUsedAt desc; top() by count desc', async () => {
    await store.record('old', new Date(1000).toISOString());
    await store.record('old', new Date(1100).toISOString()); // count 2, last 1100
    await store.record('new', new Date(5000).toISOString()); // count 1, last 5000

    expect((await store.recent()).map((r) => r.slug)).toEqual(['new', 'old']);
    expect((await store.top()).map((r) => r.slug)).toEqual(['old', 'new']);
  });

  it('tolerates a corrupt file', async () => {
    await fs.writeFile(path.join(dir, 'prompt-usage.json'), '{ broken');
    expect(await store.load()).toEqual({});
  });
});
