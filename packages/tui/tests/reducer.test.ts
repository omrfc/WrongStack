import { describe, expect, it } from 'vitest';
import { reducer, selectedSlashCommandLine } from '../src/app.js';
import { SETTINGS_FIELD_COUNT } from '../src/components/settings-picker.js';

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
    brain: { state: 'idle' as const },
    brainPrompt: null,
    nextId: 1,
    historyGen: 0,
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
    enhance: null,
    enhanceEnabled: true,
    enhanceBusy: false,
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

  it('addEntry supports Brain decision entries as first-class history items', () => {
    const s = reducer(initial(), {
      type: 'addEntry',
      entry: {
        kind: 'brain',
        status: 'answered',
        source: 'director',
        risk: 'medium',
        question: 'Extend budget?',
        decision: 'extend',
        rationale: 'Still making progress.',
      },
    });

    expect(s.entries[0]).toMatchObject({
      id: 1,
      kind: 'brain',
      source: 'director',
      decision: 'extend',
    });
  });

  it('brainStatus updates the live Brain status chip state', () => {
    const s = reducer(initial(), {
      type: 'brainStatus',
      state: 'deciding',
      source: 'autophase',
      risk: 'high',
      summary: 'autophase: conflict',
    });

    expect(s.brain).toMatchObject({
      state: 'deciding',
      source: 'autophase',
      risk: 'high',
      summary: 'autophase: conflict',
    });
    expect(typeof s.brain.updatedAt).toBe('number');
  });

  it('brainPromptSet and brainPromptClear manage the visible Brain prompt', () => {
    const withPrompt = reducer(initial(), {
      type: 'brainPromptSet',
      prompt: {
        requestId: 'decision-1',
        source: 'autophase',
        risk: 'high',
        question: 'Resolve conflict?',
        options: [{ id: 'review', label: 'Keep for review', recommended: true }],
      },
    });
    expect(withPrompt.brainPrompt?.question).toBe('Resolve conflict?');

    const cleared = reducer(withPrompt, { type: 'brainPromptClear' });
    expect(cleared.brainPrompt).toBeNull();
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

  // ── /clear regression: bump historyGen so <Static> remounts ─────────────
  // The visible chat history is rendered by <Static> in
  // components/history/index.tsx, which is keyed on `historyGen`. <Static>
  // writes each item to the terminal exactly once and never re-renders it —
  // the `key` is the only way to force a remount that drops the previously
  // committed entries. Without this bump, /clear wiped state.entries but
  // every committed entry stayed on screen, so users saw "history not
  // cleared" even though the React state was empty. replaceHistory already
  // bumps historyGen for the resume-replay case; clearHistory must do the
  // same or /clear is a silent no-op against the rendered transcript.

  it('clearHistory bumps historyGen so <Static> remounts (mid-session)', () => {
    // Simulate a session that has already gone through one /clear (gen=7).
    const before = { ...initial(), historyGen: 7 };
    const out = reducer(before, { type: 'clearHistory' });
    expect(out.historyGen).toBe(8);
  });

  it('clearHistory bumps historyGen from 0 (first-ever /clear)', () => {
    const out = reducer(initial(), { type: 'clearHistory' });
    expect(out.historyGen).toBe(1);
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

  // Open the settings picker with a full payload so settingsValueChange has a
  // seeded settingsPicker to mutate.
  function openSettings(s: ReturnType<typeof initial>) {
    return reducer(s, {
      type: 'settingsOpen',
      mode: 'off',
      delayMs: 45_000,
      titleAnimation: true,
      yolo: false,
      streamFleet: true,
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      featureTokenSaving: false,
      contextAutoCompact: true,
      contextStrategy: 'hybrid',
      logLevel: 'info',
      auditLevel: 'standard',
      indexOnStart: true,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      debugStream: false,
      configScope: 'global',
      restrictFsToRoot: false,
    } as never);
  }

  it('settingsValueChange flags a boot-only field (MCP) with a restart hint', () => {
    let s = openSettings(initial());
    s = reducer(s, { type: 'settingsFieldMove', delta: 8 }); // → field 8 = MCP servers
    s = reducer(s, { type: 'settingsValueChange', delta: 1 } as never);
    expect(s.settingsPicker.featureMcp).toBe(false); // toggled
    expect(s.settingsPicker.hint).toBe('↻ Takes effect next session');
  });

  it('settingsValueChange clears the hint for a live-applicable field (YOLO)', () => {
    let s = openSettings(initial());
    s = reducer(s, { type: 'settingsFieldMove', delta: 3 }); // → field 3 = YOLO (live)
    s = reducer(s, { type: 'settingsValueChange', delta: 1 } as never);
    expect(s.settingsPicker.yolo).toBe(true); // toggled
    expect(s.settingsPicker.hint).toBeUndefined();
  });

  it('settingsValueChange flags compactor strategy (boot-only) but not auto-compact toggle (live)', () => {
    // Auto-compact on/off (field 15) applies live → no hint.
    let live = openSettings(initial());
    live = reducer(live, { type: 'settingsFieldMove', delta: 15 });
    live = reducer(live, { type: 'settingsValueChange', delta: 1 } as never);
    expect(live.settingsPicker.contextAutoCompact).toBe(false);
    expect(live.settingsPicker.hint).toBeUndefined();

    // Compactor strategy (field 16) needs a restart → hint.
    let strat = openSettings(initial());
    strat = reducer(strat, { type: 'settingsFieldMove', delta: 16 });
    strat = reducer(strat, { type: 'settingsValueChange', delta: 1 } as never);
    expect(strat.settingsPicker.hint).toBe('↻ Takes effect next session');
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

  it('enhanceOpen sets the panel state and enhanceClose clears it', () => {
    let s = initial();
    const resolve = () => {};
    s = reducer(s, {
      type: 'enhanceOpen',
      info: { original: 'fix the bug', refined: 'Fix the null deref in auth.ts', resolve },
    });
    expect(s.enhance).toEqual({
      original: 'fix the bug',
      refined: 'Fix the null deref in auth.ts',
      resolve,
    });
    s = reducer(s, { type: 'enhanceClose' });
    expect(s.enhance).toBeNull();
  });

  it('enhanceSet toggles the enhanceEnabled flag', () => {
    let s = initial();
    expect(s.enhanceEnabled).toBe(true);
    s = reducer(s, { type: 'enhanceSet', enabled: false });
    expect(s.enhanceEnabled).toBe(false);
    s = reducer(s, { type: 'enhanceSet', enabled: true });
    expect(s.enhanceEnabled).toBe(true);
  });

  it('fleetCost folds per-subagent cost into the matching fleet entries', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-2', name: 'helper' });
    s = reducer(s, {
      type: 'fleetCost',
      cost: 0.5,
      input: 1000,
      output: 200,
      perAgent: {
        'agent-1': { cost: 0.3 },
        'agent-2': { cost: 0.2 },
        // An unknown id must be ignored, not crash or create an entry.
        'ghost-agent': { cost: 9.9 },
      },
    });

    expect(s.fleetCost).toBe(0.5);
    expect(s.fleetTokens).toEqual({ input: 1000, output: 200 });
    expect(s.fleet['agent-1']?.cost).toBe(0.3);
    expect(s.fleet['agent-2']?.cost).toBe(0.2);
    expect(s.fleet['ghost-agent']).toBeUndefined();
  });

  it('fleetCost without perAgent leaves entry costs untouched', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, { type: 'fleetCost', cost: 1.2 });
    expect(s.fleetCost).toBe(1.2);
    expect(s.fleet['agent-1']?.cost).toBe(0);
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

  it('steerConsume clears steeringPending, steerSnapshot, and interrupts', () => {
    let s = initial();
    s = { ...s, steeringPending: true, steerSnapshot: { runningTools: ['read'], subagents: [], subagentsTerminated: 0, partialAssistantText: '' }, interrupts: 2 };
    s = reducer(s, { type: 'steerConsume' });
    expect(s.steeringPending).toBe(false);
    expect(s.steerSnapshot).toBeNull();
    expect(s.interrupts).toBe(0);
  });

  it('steerStart sets steeringPending + steerSnapshot, steerConsume clears them back', () => {
    const snapshot = { runningTools: ['bash'], subagents: [{ label: 'w', status: 'running' as const, tool: 'grep' }], subagentsTerminated: 1, partialAssistantText: '...' };
    let s = reducer(initial(), { type: 'steerStart', snapshot });
    expect(s.steeringPending).toBe(true);
    expect(s.steerSnapshot).toEqual(snapshot);
    s = reducer(s, { type: 'steerConsume' });
    expect(s.steeringPending).toBe(false);
    expect(s.steerSnapshot).toBeNull();
  });

  it('addEntry rejects empty/whitespace text for user, assistant, info, warn, error kinds', () => {
    const emptyKinds = ['user', 'assistant', 'info', 'warn', 'error'] as const;
    for (const kind of emptyKinds) {
      let s = initial();
      // Whitespace-only
      s = reducer(s, { type: 'addEntry', entry: { kind, text: '   ' } as any });
      expect(s.entries).toHaveLength(0);
      // Empty string
      s = reducer(s, { type: 'addEntry', entry: { kind, text: '' } as any });
      expect(s.entries).toHaveLength(0);
    }
  });

  it('addEntry accepts non-empty text for user, assistant, info kinds', () => {
    let s = initial();
    s = reducer(s, { type: 'addEntry', entry: { kind: 'user', text: 'hello' } });
    expect(s.entries).toHaveLength(1);
    s = reducer(s, { type: 'addEntry', entry: { kind: 'assistant', text: 'hi' } });
    expect(s.entries).toHaveLength(2);
    s = reducer(s, { type: 'addEntry', entry: { kind: 'info', text: 'ok' } });
    expect(s.entries).toHaveLength(3);
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

describe('settings picker reducer', () => {
  // Minimal state slice — only the fields the settings cases touch. The
  // reducer returns {...state, settingsPicker}, so other fields are irrelevant.
  const base = (over: Record<string, unknown> = {}) =>
    ({
      settingsPicker: {
        open: false,
        field: 0,
        mode: 'off' as const,
        delayMs: 0,
        titleAnimation: true,
        yolo: false,
        streamFleet: true,
        chime: false,
        confirmExit: true,
        nextPrediction: false,
        featureMcp: true,
        featurePlugins: true,
        featureMemory: true,
        featureSkills: true,
        featureModelsRegistry: true,
        contextAutoCompact: true,
        contextStrategy: 'hybrid' as const,
        logLevel: 'info' as const,
        auditLevel: 'standard' as const,
        indexOnStart: true,
        maxIterations: 500,
        autoProceedMaxIterations: 50,
        enhanceDelayMs: 60_000,
        enhanceEnabled: true,
        enhanceLanguage: 'original' as const,
        debugStream: false,
        configScope: 'global' as const,
        ...over,
      },
    }) as unknown as Parameters<typeof reducer>[0];

  it('opens with the supplied mode + delay and focuses the first field', () => {
    const s = reducer(base(), {
      type: 'settingsOpen',
      mode: 'auto',
      delayMs: 30_000,
      titleAnimation: true,
      yolo: false,
      streamFleet: true,
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      contextAutoCompact: true,
      contextStrategy: 'hybrid',
      logLevel: 'info',
      auditLevel: 'standard',
      indexOnStart: true,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      debugStream: false,
      configScope: 'global',
    });
    expect(s.settingsPicker).toMatchObject({ open: true, field: 0, mode: 'auto', delayMs: 30_000 });
  });

  it('close flips open false but keeps the values', () => {
    const s = reducer(base({ open: true, mode: 'suggest', delayMs: 15_000 }), {
      type: 'settingsClose',
    });
    expect(s.settingsPicker).toMatchObject({ open: false, mode: 'suggest', delayMs: 15_000 });
  });

  it('field move wraps between fields', () => {
    // Wrap back to 0 after the last field (SETTINGS_FIELD_COUNT fields total).
    let s = reducer(base({ open: true, field: 0 }), { type: 'settingsFieldMove', delta: 1 });
    expect(s.settingsPicker.field).toBe(1);
    // Move forward enough to wrap around
    for (let i = 1; i < SETTINGS_FIELD_COUNT; i++) {
      s = reducer(s, { type: 'settingsFieldMove', delta: 1 });
    }
    expect(s.settingsPicker.field).toBe(0);
  });

  it('settingsFieldSet focuses an explicit field', () => {
    const s = reducer(base({ open: true, field: 0 }), { type: 'settingsFieldSet', field: 1 });
    expect(s.settingsPicker.field).toBe(1);
  });

  it('value change cycles the mode on field 0 (wraps off→suggest→auto→off)', () => {
    let s = reducer(base({ open: true, field: 0, mode: 'off' }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(s.settingsPicker.mode).toBe('suggest');
    s = reducer(
      { ...s, settingsPicker: { ...s.settingsPicker, mode: 'auto' } },
      {
        type: 'settingsValueChange',
        delta: 1,
      },
    );
    expect(s.settingsPicker.mode).toBe('off');
  });

  it('value change steps the delay presets on field 1 (and wraps backwards)', () => {
    const up = reducer(base({ open: true, field: 1, delayMs: 0 }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(up.settingsPicker.delayMs).toBe(15_000);
    const down = reducer(base({ open: true, field: 1, delayMs: 0 }), {
      type: 'settingsValueChange',
      delta: -1,
    });
    expect(down.settingsPicker.delayMs).toBe(120_000);
  });

});

describe('Monitor overlays do not block input buffer mutations', () => {
  // Regression: F2 (fleet), F3 (agents), F4 (worktree), F6 (todos), F7 (queue)
  // and the autoPhase monitor used to make handleKey swallow every keystroke
  // except F-keys and Esc, so typing into the chat input behind the panel
  // silently failed. The guard was removed; the reducer is now the only
  // place that decides whether a `setBuffer` action takes effect, and it
  // must accept the action regardless of overlay state.
  it('setBuffer still mutates the buffer when every monitor overlay is open', () => {
    const overlayKeys = [
      'monitorOpen',
      'agentsMonitorOpen',
      'worktreeMonitorOpen',
      'todosMonitorOpen',
      'queuePanelOpen',
    ] as const;

    for (const key of overlayKeys) {
      const closed: Record<string, unknown> = { monitorOpen: false };
      // Build a baseline state that mirrors what App.tsx feeds to handleKey:
      // the overlay under test is open, every other overlay is closed.
      for (const k of overlayKeys) closed[k] = false;
      closed[key] = true;

      const typed = reducer(
        { ...initial(), ...closed } as Parameters<typeof reducer>[0],
        { type: 'setBuffer', buffer: 'hello world', cursor: 11 },
      );
      expect(typed.buffer, `setBuffer should work while ${key} is true`).toBe('hello world');
      expect(typed.cursor).toBe(11);
    }
  });

  it('setBuffer still mutates the buffer when autoPhase monitor is open', () => {
    const s = reducer(
      {
        ...initial(),
        autoPhase: {
          title: 't',
          phases: {},
          runningPhaseIds: [],
          elapsedMs: 0,
          monitorOpen: true,
        },
      } as Parameters<typeof reducer>[0],
      { type: 'setBuffer', buffer: 'draft text', cursor: 10 },
    );
    expect(s.buffer).toBe('draft text');
    expect(s.cursor).toBe(10);
  });

  it('clearInput resets the buffer even when a monitor overlay is open', () => {
    const dirty: Record<string, unknown> = {
      monitorOpen: false,
      agentsMonitorOpen: false,
      worktreeMonitorOpen: false,
      todosMonitorOpen: false,
      queuePanelOpen: false,
    };
    dirty.monitorOpen = true;
    const s = reducer(
      {
        ...initial(),
        ...dirty,
        buffer: 'leftover draft',
        cursor: 14,
        historyIndex: 1,
      } as Parameters<typeof reducer>[0],
      { type: 'clearInput' },
    );
    expect(s.buffer).toBe('');
    expect(s.cursor).toBe(0);
    expect(s.historyIndex).toBe(0);
  });
});
