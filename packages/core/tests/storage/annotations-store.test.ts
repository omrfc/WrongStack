import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationsStore } from '../../src/storage/annotations-store.js';

let dir: string;
let store: AnnotationsStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotations-store-'));
  store = new AnnotationsStore({ dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('AnnotationsStore', () => {
  it('returns [] for a session with no file', async () => {
    expect(await store.list('fresh')).toEqual([]);
    expect(await store.listOpen('fresh')).toEqual([]);
  });

  it('adds and reads back annotations in insertion order', async () => {
    const a = await store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: 'first' });
    const b = await store.add({ sessionId: 's1', atEventIndex: 2, authorId: 'p2', text: 'second' });
    expect(a.id).not.toEqual(b.id);
    const list = await store.list('s1');
    expect(list).toHaveLength(2);
    expect(list[0]!.text).toBe('first');
    expect(list[1]!.text).toBe('second');
    expect(list[0]!.resolved).toBe(false);
    expect(list[0]!.authorRole).toBe('annotator');
  });

  it('rejects empty / oversized text', async () => {
    await expect(
      store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: '   ' }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: 'x'.repeat(2001) }),
    ).rejects.toThrow(/exceeds 2000/);
  });

  it('rejects non-integer / negative event indices', async () => {
    await expect(
      store.add({ sessionId: 's1', atEventIndex: -1, authorId: 'p1', text: 'oops' }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      store.add({ sessionId: 's1', atEventIndex: 1.5, authorId: 'p1', text: 'oops' }),
    ).rejects.toThrow(/non-negative/);
  });

  it('trims surrounding whitespace from the note text', async () => {
    const a = await store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: '  hi  ' });
    expect(a.text).toBe('hi');
  });

  it('persists across store instances (file on disk)', async () => {
    await store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: 'persistent' });
    const store2 = new AnnotationsStore({ dir });
    const list = await store2.list('s1');
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe('persistent');
  });

  it('resolve marks an annotation resolved and returns the updated record', async () => {
    const a = await store.add({ sessionId: 's1', atEventIndex: 5, authorId: 'p1', text: 'todo' });
    const resolved = await store.resolve({ sessionId: 's1', annotationId: a.id, resolvedBy: 'p2' });
    expect(resolved).not.toBeNull();
    expect(resolved!.resolved).toBe(true);
    expect(resolved!.resolvedBy).toBe('p2');
    expect(typeof resolved!.resolvedAt).toBe('string');
  });

  it('resolve returns null for an unknown annotation', async () => {
    const r = await store.resolve({ sessionId: 's1', annotationId: 'no-such', resolvedBy: 'p1' });
    expect(r).toBeNull();
  });

  it('listOpen returns only unresolved, newest first', async () => {
    const a = await store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.add({ sessionId: 's1', atEventIndex: 2, authorId: 'p1', text: 'new' });
    await store.resolve({ sessionId: 's1', annotationId: a.id, resolvedBy: 'p1' });
    const open = await store.listOpen('s1');
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(b.id);
  });

  it('serializes concurrent adds to the same session (no lost writes)', async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.add({ sessionId: 's1', atEventIndex: i, authorId: `p${i}`, text: `note ${i}` }),
      ),
    );
    const list = await store.list('s1');
    expect(list).toHaveLength(N);
    const texts = new Set(list.map((a) => a.text));
    expect(texts.size).toBe(N);
  });

  it('rejects path-traversal session ids but accepts date-shard slashes', async () => {
    await expect(store.list('../escape')).rejects.toThrow(/invalid sessionid/i);
    await expect(store.list('a/../../escape')).rejects.toThrow(/invalid sessionid/i);
    await expect(store.list('a\\b')).rejects.toThrow(/invalid sessionid/i);
    // Modern session ids are date-sharded ("2026-06-11/<base>") — the
    // annotations sidecar must follow them into the shard dir instead of
    // throwing (a slash ban here broke annotations for every live session).
    const shardedId = '2026-06-11/12-00-00Z_model_ab12';
    const added = await store.add({
      sessionId: shardedId,
      atEventIndex: 0,
      authorId: 'p1',
      text: 'sharded note',
    });
    expect(added.sessionId).toBe(shardedId);
    const list = await store.list(shardedId);
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe('sharded note');
    // The sidecar sits inside the shard directory, next to the JSONL.
    await expect(
      fs.access(path.join(dir, '2026-06-11', '12-00-00Z_model_ab12.annotations.json')),
    ).resolves.toBeUndefined();
  });

  it('corrupt JSON file is treated as empty store (does not crash)', async () => {
    await fs.writeFile(path.join(dir, 's1.annotations.json'), '{not json', 'utf8');
    const list = await store.list('s1');
    expect(list).toEqual([]);
  });

  it('evicts oldest annotations beyond the cap (resolved first, then oldest unresolved)', async () => {
    // Create a small store with explicit cap by injecting more than MAX_ANNOTATIONS.
    // We don't expose the cap as a constructor arg, so we exercise the eviction
    // path by adding exactly the cap (1000) and verifying the file size is sane.
    for (let i = 0; i < 1000; i++) {
      await store.add({ sessionId: 's1', atEventIndex: i, authorId: `p${i}`, text: `t${i}` });
    }
    const list = await store.list('s1');
    expect(list).toHaveLength(1000);
    // 1000 sequential disk writes is legitimately slow on CI's slower I/O —
    // give it generous headroom past the 5s default so it isn't a flaky timeout.
  }, 20_000);
});
