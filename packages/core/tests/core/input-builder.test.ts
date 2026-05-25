import { describe, expect, it } from 'vitest';
import { InputBuilder } from '../../src/core/input-builder.js';
import { DefaultAttachmentStore } from '../../src/storage/attachment-store.js';

function makeBuilder() {
  const store = new DefaultAttachmentStore();
  const builder = new InputBuilder({ store, pasteLineThreshold: 3, pasteCharThreshold: 50 });
  return { store, builder };
}

describe('InputBuilder', () => {
  it('inlines small text and submits a single text block', async () => {
    const { builder } = makeBuilder();
    builder.appendText('hi ');
    builder.appendText('there');
    const blocks = await builder.submit();
    expect(blocks).toEqual([{ type: 'text', text: 'hi there' }]);
  });

  it('collapses large pastes to [pasted #N] placeholder and expands on submit', async () => {
    const { builder } = makeBuilder();
    builder.appendText('look: ');
    const big = 'a'.repeat(200);
    const placeholder = await builder.appendPaste(big);
    expect(placeholder).toBe('[pasted #1]');
    expect(builder.text).toBe('look: [pasted #1]');
    const blocks = await builder.submit();
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text).toContain(big);
  });

  it('inlines pastes under the threshold', async () => {
    const { builder } = makeBuilder();
    const placeholder = await builder.appendPaste('short');
    expect(placeholder).toBeNull();
    expect(builder.text).toBe('short');
    expect(builder.attachments).toHaveLength(0);
  });

  it('always collapses images regardless of size', async () => {
    const { builder } = makeBuilder();
    builder.appendText('see this: ');
    const ph = await builder.appendImage('AAAA', 'image/png');
    expect(ph).toBe('[image #1]');
    const blocks = await builder.submit();
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });

  it('submit() resets state for next turn', async () => {
    const { builder } = makeBuilder();
    builder.appendText('first');
    await builder.submit();
    expect(builder.text).toBe('');
    expect(builder.attachments).toHaveLength(0);
    builder.appendText('second');
    expect(builder.text).toBe('second');
  });

  it('isEmpty reflects whitespace-only state', async () => {
    const { builder } = makeBuilder();
    expect(builder.isEmpty).toBe(true);
    builder.appendText('   \n\t');
    expect(builder.isEmpty).toBe(true);
    builder.appendText('x');
    expect(builder.isEmpty).toBe(false);
  });

  it('wouldCollapse mirrors appendPaste collapse decision without mutating state', async () => {
    const { builder } = makeBuilder(); // thresholds: 3 lines / 50 chars
    expect(builder.wouldCollapse('short')).toBe(false);
    expect(builder.wouldCollapse('a'.repeat(50))).toBe(true);
    expect(builder.wouldCollapse('one\ntwo\nthree')).toBe(true);
    // Predicate is pure — it must not append anything to the display.
    expect(builder.text).toBe('');
    // And it agrees with the actual appendPaste outcome.
    expect(await builder.appendPaste('short')).toBeNull();
    builder.reset();
    expect(await builder.appendPaste('a'.repeat(50))).toBe('[pasted #1]');
  });

  it('numbers placeholders independently per kind', async () => {
    const { builder } = makeBuilder();
    await builder.appendPaste('x'.repeat(100));
    await builder.appendImage('AAAA', 'image/png');
    await builder.appendPaste('y'.repeat(100));
    expect(builder.text).toContain('[pasted #1]');
    expect(builder.text).toContain('[image #1]');
    expect(builder.text).toContain('[pasted #2]');
  });
});
