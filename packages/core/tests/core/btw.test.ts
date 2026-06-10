/**
 * Unit tests for the `/btw` non-aborting steering feature:
 * setBtwNote(), consumeBtwNotes(), pendingBtwCount(), buildBtwBlock().
 */
import { describe, expect, it } from 'vitest';
import { buildBtwBlock, consumeBtwNotes, pendingBtwCount, setBtwNote } from '../../src/core/btw.js';
import { Context } from '../../src/core/context.js';

function makeCtx(): Context {
  return new Context({
    systemPrompt: [],
    provider: null as never,
    session: { id: 'x', pendingToolUses: [], append: async () => {}, flush: async () => {} },
    signal: new AbortController().signal,
    tokenCounter: { account: () => {} } as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'test',
  });
}

describe('setBtwNote / pendingBtwCount', () => {
  it('stores a note and reports the pending count', () => {
    const ctx = makeCtx();
    expect(pendingBtwCount(ctx)).toBe(0);
    expect(setBtwNote(ctx, 'check the auth flow')).toBe(1);
    expect(pendingBtwCount(ctx)).toBe(1);
  });

  it('ignores blank / whitespace-only notes', () => {
    const ctx = makeCtx();
    expect(setBtwNote(ctx, '   ')).toBe(0);
    expect(setBtwNote(ctx, '')).toBe(0);
    expect(pendingBtwCount(ctx)).toBe(0);
  });

  it('trims surrounding whitespace', () => {
    const ctx = makeCtx();
    setBtwNote(ctx, '  use pnpm not npm  ');
    expect(consumeBtwNotes(ctx)).toEqual(['use pnpm not npm']);
  });

  it('accumulates multiple notes in order', () => {
    const ctx = makeCtx();
    setBtwNote(ctx, 'first');
    setBtwNote(ctx, 'second');
    expect(pendingBtwCount(ctx)).toBe(2);
    expect(consumeBtwNotes(ctx)).toEqual(['first', 'second']);
  });

  it('caps the queue at 20 (keeps the most recent)', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 25; i++) setBtwNote(ctx, `note-${i}`);
    const notes = consumeBtwNotes(ctx);
    expect(notes).toHaveLength(20);
    expect(notes[0]).toBe('note-5');
    expect(notes[19]).toBe('note-24');
  });
});

describe('consumeBtwNotes', () => {
  it('returns and clears the queue', () => {
    const ctx = makeCtx();
    setBtwNote(ctx, 'a');
    expect(consumeBtwNotes(ctx)).toEqual(['a']);
    expect(pendingBtwCount(ctx)).toBe(0);
    // Second consume is empty.
    expect(consumeBtwNotes(ctx)).toEqual([]);
  });

  it('returns an empty array when nothing is pending', () => {
    expect(consumeBtwNotes(makeCtx())).toEqual([]);
  });
});

describe('buildBtwBlock', () => {
  it('renders a marker and bulleted notes', () => {
    const text = buildBtwBlock(['one', 'two']);
    expect(text).toContain('[BY THE WAY');
    expect(text).toContain('- one');
    expect(text).toContain('- two');
    expect(text.trimEnd().endsWith(']')).toBe(true);
  });
});
