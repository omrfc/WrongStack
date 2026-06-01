import { describe, expect, it } from 'vitest';
import { reducer, selectedSlashCommandLine } from '../src/app.js';

function initial() {
  return {
    entries: [],
    buffer: '',
    cursor: 0,
    streamingText: '',
    toolStream: null,
    status: 'idle' as const,
    interrupts: 0,
    steeringPending: false,
    steerSnapshot: null,
    hint: '',
    nextId: 1,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map<string, { name: string; startedAt: number }>(),
    queue: [],
    nextQueueId: 1,
    inputHistory: [],
    historyIndex: 0,
    modelPicker: {
      open: false,
      step: 'provider' as const,
      providerOptions: [],
      modelOptions: [],
      selected: 0,
    },
    confirm: null,
    contextChipVersion: 0,
    fleet: {},
    fleetCost: 0,
    streamFleet: true,
  };
}

describe('TUI reducer', () => {
  it('fleetBatch folds actions in order into one new state', () => {
    let s = initial();
    // A batch of three appends behaves identically to dispatching them one by
    // one — same ids, same order — but in a single reducer pass (one render).
    s = reducer(s, {
      type: 'fleetBatch',
      actions: [
        { type: 'addEntry', entry: { kind: 'info', text: 'a' } },
        { type: 'addEntry', entry: { kind: 'info', text: 'b' } },
        { type: 'addEntry', entry: { kind: 'info', text: 'c' } },
      ],
    });
    expect(s.entries.map((e) => (e as { text: string }).text)).toEqual(['a', 'b', 'c']);
    expect(s.entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(s.nextId).toBe(4);
  });

  it('fleetBatch with no actions returns an equivalent state', () => {
    const s = initial();
    const out = reducer(s, { type: 'fleetBatch', actions: [] });
    expect(out.entries).toEqual(s.entries);
    expect(out.nextId).toBe(s.nextId);
  });

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

  it('setBuffer + clearInput reset cursor and history index', () => {
    let s = initial();
    s = reducer(s, { type: 'historyPush', text: 'older message' });
    s = reducer(s, { type: 'historyUp' });
    s = reducer(s, { type: 'setBuffer', buffer: 'hello', cursor: 5 });
    expect(s.buffer).toBe('hello');
    expect(s.historyIndex).toBe(1);
    s = reducer(s, { type: 'clearInput' });
    expect(s.buffer).toBe('');
    expect(s.cursor).toBe(0);
    expect(s.historyIndex).toBe(0);
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

  it('fleetTool keeps only the last two compact tool summaries', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, {
      type: 'fleetTool',
      id: 'agent-1',
      name: 'read',
      ok: true,
      durationMs: 12,
      outputBytes: 399,
      outputLines: 7,
    });
    s = reducer(s, {
      type: 'fleetTool',
      id: 'agent-1',
      name: 'write',
      ok: true,
      durationMs: 20,
    });
    s = reducer(s, {
      type: 'fleetTool',
      id: 'agent-1',
      name: 'test',
      ok: false,
      durationMs: 30,
    });

    expect(s.fleet['agent-1']?.toolCalls).toBe(3);
    expect(s.fleet['agent-1']?.recentTools.map((tool) => tool.name)).toEqual(['write', 'test']);
    expect(s.fleet['agent-1']?.recentTools[1]?.ok).toBe(false);
  });

  it('fleetMessage keeps only the last two compact text snippets', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, { type: 'fleetMessage', id: 'agent-1', text: ' first  message ' });
    s = reducer(s, { type: 'fleetMessage', id: 'agent-1', text: 'second message' });
    s = reducer(s, { type: 'fleetMessage', id: 'agent-1', text: 'third message' });

    expect(s.fleet['agent-1']?.recentMessages.map((message) => message.text)).toEqual([
      'second message',
      'third message',
    ]);
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

describe('selectedSlashCommandLine', () => {
  it('returns the selected command line for Enter dispatch', () => {
    expect(
      selectedSlashCommandLine({
        open: true,
        selected: 1,
        matches: [
          { name: 'help', description: 'Help', isBuiltin: true },
          { name: 'init', description: 'Init', isBuiltin: true },
        ],
      }),
    ).toBe('/init');
  });

  it('returns null when the slash picker has nothing to dispatch', () => {
    expect(selectedSlashCommandLine({ open: false, selected: 0, matches: [] })).toBeNull();
    expect(selectedSlashCommandLine({ open: true, selected: 0, matches: [] })).toBeNull();
  });
});
