import { describe, it, expect } from 'vitest';
import { reducer } from '../src/app.js';

function initial() {
  return {
    entries: [],
    buffer: '',
    cursor: 0,
    placeholders: [],
    streamingText: '',
    status: 'idle' as const,
    interrupts: 0,
    hint: '',
    nextId: 1,
    picker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map<string, { name: string; startedAt: number }>(),
    queue: [],
    nextQueueId: 1,
  };
}

describe('TUI reducer', () => {
  it('addEntry assigns sequential ids', () => {
    let s = initial();
    s = reducer(s, { type: 'addEntry', entry: { kind: 'user', text: 'hi' } });
    s = reducer(s, { type: 'addEntry', entry: { kind: 'assistant', text: 'hello' } });
    expect(s.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(s.nextId).toBe(3);
  });

  it('addEntry is append-only and never drops oldest entries', () => {
    // Entries are rendered via Ink's <Static>, which forbids removals or
    // reordering. Trimming would break the scrollback. Memory growth is
    // bounded in practice by the terminal's own scrollback limit.
    let s = initial();
    for (let i = 0; i < 600; i++) {
      s = reducer(s, {
        type: 'addEntry',
        entry: { kind: 'info', text: `entry-${i}` },
      });
    }
    expect(s.entries.length).toBe(600);
    expect((s.entries[0] as { text: string }).text).toBe('entry-0');
    expect((s.entries[599] as { text: string }).text).toBe('entry-599');
  });

  it('setBuffer + clearInput reset cursor and placeholders', () => {
    let s = initial();
    s = reducer(s, { type: 'setBuffer', buffer: 'hello', cursor: 5 });
    s = reducer(s, { type: 'addPlaceholder', ph: '[pasted #1] (3 lines)' });
    expect(s.buffer).toBe('hello');
    expect(s.placeholders).toHaveLength(1);
    s = reducer(s, { type: 'clearInput' });
    expect(s.buffer).toBe('');
    expect(s.cursor).toBe(0);
    expect(s.placeholders).toEqual([]);
    expect(s.picker.open).toBe(false);
  });

  it('streamDelta concatenates; streamReset clears', () => {
    let s = initial();
    s = reducer(s, { type: 'streamDelta', delta: 'Hel' });
    s = reducer(s, { type: 'streamDelta', delta: 'lo!' });
    expect(s.streamingText).toBe('Hello!');
    s = reducer(s, { type: 'streamReset' });
    expect(s.streamingText).toBe('');
  });

  it('picker open/close lifecycle', () => {
    let s = initial();
    s = reducer(s, { type: 'pickerOpen', query: 'src' });
    expect(s.picker.open).toBe(true);
    expect(s.picker.query).toBe('src');
    s = reducer(s, {
      type: 'pickerSetMatches',
      query: 'src',
      matches: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    expect(s.picker.matches).toHaveLength(3);
    s = reducer(s, { type: 'pickerMove', delta: 1 });
    expect(s.picker.selected).toBe(1);
    s = reducer(s, { type: 'pickerMove', delta: -2 });
    expect(s.picker.selected).toBe(2); // wraps
    s = reducer(s, { type: 'pickerClose' });
    expect(s.picker.open).toBe(false);
    expect(s.picker.matches).toEqual([]);
  });

  it('pickerSetMatches with stale query is dropped', () => {
    let s = initial();
    s = reducer(s, { type: 'pickerOpen', query: 'foo' });
    s = reducer(s, { type: 'pickerSetMatches', query: 'old', matches: ['x'] });
    expect(s.picker.matches).toEqual([]);
  });

  it('pickerMove on empty matches is a no-op', () => {
    let s = initial();
    s = reducer(s, { type: 'pickerOpen', query: 'x' });
    s = reducer(s, { type: 'pickerMove', delta: 1 });
    expect(s.picker.selected).toBe(0);
  });

  it('interrupt counter and resetInterrupts', () => {
    let s = initial();
    s = reducer(s, { type: 'interrupt' });
    s = reducer(s, { type: 'interrupt' });
    expect(s.interrupts).toBe(2);
    s = reducer(s, { type: 'resetInterrupts' });
    expect(s.interrupts).toBe(0);
  });

  it('toolStarted tracks running tools; toolEnded clears by id', () => {
    let s = initial();
    s = reducer(s, { type: 'toolStarted', id: 't1', name: 'read' });
    s = reducer(s, { type: 'toolStarted', id: 't2', name: 'bash' });
    expect(s.runningTools.size).toBe(2);
    s = reducer(s, { type: 'toolEnded', id: 't1' });
    expect(s.runningTools.size).toBe(1);
    expect(s.runningTools.has('t2')).toBe(true);
  });

  it('toolEnded falls back to matching by name when id is unknown', () => {
    let s = initial();
    s = reducer(s, { type: 'toolStarted', id: 't1', name: 'read' });
    s = reducer(s, { type: 'toolStarted', id: 't2', name: 'read' });
    s = reducer(s, { type: 'toolEnded', name: 'read' });
    // Only one of the two should remain.
    expect(s.runningTools.size).toBe(1);
  });

  it('toolEnded with unknown id and no name is a no-op', () => {
    let s = initial();
    s = reducer(s, { type: 'toolStarted', id: 't1', name: 'read' });
    s = reducer(s, { type: 'toolEnded', id: 'nope' });
    expect(s.runningTools.size).toBe(1);
  });

  it('enqueue appends with sequential queue ids', () => {
    let s = initial();
    s = reducer(s, { type: 'enqueue', item: { displayText: 'first', blocks: [] } });
    s = reducer(s, { type: 'enqueue', item: { displayText: 'second', blocks: [] } });
    expect(s.queue.map((q) => q.id)).toEqual([1, 2]);
    expect(s.queue.map((q) => q.displayText)).toEqual(['first', 'second']);
    expect(s.nextQueueId).toBe(3);
  });

  it('dequeueFirst removes the head (FIFO)', () => {
    let s = initial();
    s = reducer(s, { type: 'enqueue', item: { displayText: 'a', blocks: [] } });
    s = reducer(s, { type: 'enqueue', item: { displayText: 'b', blocks: [] } });
    s = reducer(s, { type: 'dequeueFirst' });
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]?.displayText).toBe('b');
  });

  it('dequeueFirst on empty queue is a no-op (same ref)', () => {
    const s = initial();
    const next = reducer(s, { type: 'dequeueFirst' });
    expect(next).toBe(s);
  });

  it('queueClear empties the queue', () => {
    let s = initial();
    s = reducer(s, { type: 'enqueue', item: { displayText: 'a', blocks: [] } });
    s = reducer(s, { type: 'enqueue', item: { displayText: 'b', blocks: [] } });
    s = reducer(s, { type: 'queueClear' });
    expect(s.queue).toEqual([]);
  });

  it('queueClear on empty queue is a no-op (same ref)', () => {
    const s = initial();
    const next = reducer(s, { type: 'queueClear' });
    expect(next).toBe(s);
  });

  it('queueDelete drops by 1-based positions and ignores out-of-range', () => {
    let s = initial();
    for (const t of ['a', 'b', 'c', 'd']) {
      s = reducer(s, { type: 'enqueue', item: { displayText: t, blocks: [] } });
    }
    s = reducer(s, { type: 'queueDelete', positions: [1, 3, 99, 0, -1] });
    expect(s.queue.map((q) => q.displayText)).toEqual(['b', 'd']);
  });

  it('queueDelete with only invalid positions is a no-op', () => {
    let s = initial();
    s = reducer(s, { type: 'enqueue', item: { displayText: 'a', blocks: [] } });
    const before = s;
    s = reducer(s, { type: 'queueDelete', positions: [99, 0, -5] });
    expect(s).toBe(before);
  });
});
