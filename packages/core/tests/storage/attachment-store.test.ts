import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultAttachmentStore } from '../../src/storage/attachment-store.js';

describe('DefaultAttachmentStore', () => {
  it('assigns sequential seqs per kind and stable ids', async () => {
    const store = new DefaultAttachmentStore();
    const a = await store.add({ kind: 'text', data: 'hello' });
    const b = await store.add({ kind: 'text', data: 'world' });
    const c = await store.add({ kind: 'image', data: 'aGk=', meta: { mediaType: 'image/png' } });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(1);
    expect(a.id).not.toBe(b.id);
  });

  it('expands placeholders for known refs and preserves unknown ones', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'text', data: 'lorem ipsum' });
    const blocks = await store.expand('see [pasted #1] and [pasted #9] for details');
    // All pure-text expansions merge into one text block
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('see ');
    expect(text).toContain('lorem ipsum');
    expect(text).toContain('[pasted #9]'); // unknown preserved literally
    expect(text).toContain('for details');
  });

  it('keeps image blocks separate from surrounding text', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'image', data: 'AAAA', meta: { mediaType: 'image/png' } });
    const blocks = await store.expand('before [image #1] after');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'text', text: 'before ' });
    expect(blocks[1]).toMatchObject({ type: 'image' });
    expect(blocks[2]).toEqual({ type: 'text', text: ' after' });
  });

  it('expands an image placeholder to a base64 image block', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({
      kind: 'image',
      data: 'iVBORw0KGgo=',
      meta: { mediaType: 'image/png' },
    });
    const blocks = await store.expand('look: [image #1]');
    const img = blocks.find((b) => b.type === 'image');
    expect(img).toBeDefined();
    expect(img).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('returns plain text unchanged when no placeholders', async () => {
    const store = new DefaultAttachmentStore();
    const blocks = await store.expand('just text here');
    expect(blocks).toEqual([{ type: 'text', text: 'just text here' }]);
  });

  it('returns empty array for empty input', async () => {
    const store = new DefaultAttachmentStore();
    const blocks = await store.expand('');
    expect(blocks).toEqual([]);
  });

  it('spools large payloads to disk and re-reads them on expand', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-att-'));
    const store = new DefaultAttachmentStore({ spoolDir: dir, spoolThresholdBytes: 16 });
    const big = 'x'.repeat(1024);
    const ref = await store.add({ kind: 'text', data: big });
    const att = await store.get(ref.id);
    expect(att?.path).toBeDefined();
    expect(att?.data).toBeUndefined();
    const blocks = await store.expand('[pasted #1]');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text).toContain(big);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
