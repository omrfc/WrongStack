import { describe, expect, it } from 'vitest';
import { pruneToolInput, reducer } from '../src/app-reducer.js';

// Minimal state slice — same pattern as reducer.test.ts: the reducer only
// touches the fields the action needs.
function initial() {
  return {
    entries: [],
    nextId: 1,
  } as never;
}

describe('pruneToolInput (history entry retention cap)', () => {
  it('passes small inputs through structurally unchanged', () => {
    const input = { path: 'src/a.ts', limit: 10, flags: ['-n'], nested: { ok: true } };
    expect(pruneToolInput(input)).toEqual(input);
  });

  it('truncates oversized strings and records the original length', () => {
    const big = 'x'.repeat(50_000);
    const out = pruneToolInput({ content: big }) as { content: string };
    expect(out.content.length).toBeLessThan(2_400);
    expect(out.content).toContain('[truncated, 50000 chars');
  });

  it('truncates strings nested inside arrays and objects', () => {
    const big = 'y'.repeat(10_000);
    const out = pruneToolInput({ edits: [{ new_string: big }] }) as {
      edits: Array<{ new_string: string }>;
    };
    expect(out.edits[0]!.new_string).toContain('[truncated');
  });

  it('caps array breadth with a marker for dropped items', () => {
    const out = pruneToolInput({ files: Array.from({ length: 200 }, (_, i) => `f${i}`) }) as {
      files: string[];
    };
    expect(out.files.length).toBe(65); // 64 kept + 1 marker
    expect(out.files[64]).toContain('136 more items');
  });

  it('caps recursion depth', () => {
    const deep = { a: { b: { c: { d: { e: 'leaf' } } } } };
    const out = pruneToolInput(deep) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('[pruned: too deep]');
  });

  it('leaves non-string primitives alone', () => {
    expect(pruneToolInput(42)).toBe(42);
    expect(pruneToolInput(null)).toBe(null);
    expect(pruneToolInput(true)).toBe(true);
  });
});

describe('addEntry applies pruning to tool entries', () => {
  it('stores a truncated copy of large tool inputs', () => {
    const big = 'z'.repeat(100_000);
    const next = reducer(initial(), {
      type: 'addEntry',
      entry: {
        kind: 'tool',
        name: 'write',
        durationMs: 5,
        ok: true,
        input: { path: 'a.txt', content: big },
        output: 'ok',
      },
    } as never);
    const entry = next.entries[next.entries.length - 1] as never as {
      input: { content: string; path: string };
    };
    expect(entry.input.content.length).toBeLessThan(2_400);
    expect(entry.input.path).toBe('a.txt');
  });

  it('does not touch non-tool entries', () => {
    const next = reducer(initial(), {
      type: 'addEntry',
      entry: { kind: 'assistant', text: 'hello world' },
    } as never);
    const entry = next.entries[next.entries.length - 1] as never as { text: string };
    expect(entry.text).toBe('hello world');
  });
});
