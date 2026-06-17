import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../src/stores/session-store';

// persist middleware with partialize: () => ({}) — nothing is persisted
// so we don't need localStorage mocking

function resetStore() {
  useSessionStore.setState({
    session: null,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastInputTokens: 0,
    cost: 0,
    startTime: null,
    maxContext: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    projectName: '',
    projectRoot: '',
    cwd: '',
    mode: 'default',
    modes: [],
    contextMode: 'balanced',
    contextModes: [],
    iteration: null,
    todos: [],
  });
}

const makeSession = (overrides: Partial<{
  id: string; title: string; startedAt: string; provider: string; model: string
}> = {}): Parameters<typeof useSessionStore.getState>[0]['session'] => ({
  id: 'session-1',
  title: 'Test Session',
  startedAt: '2024-01-01T00:00:00.000Z',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet',
  ...overrides,
});

// ── setSession ─────────────────────────────────────────────────────

describe('setSession', () => {
  beforeEach(() => resetStore());

  it('sets session', () => {
    const session = makeSession();
    useSessionStore.getState().setSession(session);
    expect(useSessionStore.getState().session).toEqual(session);
  });

  it('can set session to null', () => {
    useSessionStore.setState({ session: makeSession() });
    useSessionStore.getState().setSession(null);
    expect(useSessionStore.getState().session).toBe(null);
  });
});

// ── updateUsage ───────────────────────────────────────────────────

describe('updateUsage', () => {
  beforeEach(() => resetStore());

  it('accumulates input tokens', () => {
    useSessionStore.getState().updateUsage({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 });
    useSessionStore.getState().updateUsage({ input: 200, output: 0, cacheRead: 0, cacheWrite: 0 });
    const state = useSessionStore.getState();
    expect(state.totalTokens.input).toBe(300);
  });

  it('accumulates output tokens', () => {
    useSessionStore.getState().updateUsage({ input: 0, output: 50, cacheRead: 0, cacheWrite: 0 });
    useSessionStore.getState().updateUsage({ input: 0, output: 70, cacheRead: 0, cacheWrite: 0 });
    expect(useSessionStore.getState().totalTokens.output).toBe(120);
  });

  it('accumulates cacheRead tokens', () => {
    useSessionStore.getState().updateUsage({ input: 0, output: 0, cacheRead: 10, cacheWrite: 0 });
    useSessionStore.getState().updateUsage({ input: 0, output: 0, cacheRead: 20, cacheWrite: 0 });
    expect(useSessionStore.getState().totalTokens.cacheRead).toBe(30);
  });

  it('accumulates cacheWrite tokens', () => {
    useSessionStore.getState().updateUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 5 });
    useSessionStore.getState().updateUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 15 });
    expect(useSessionStore.getState().totalTokens.cacheWrite).toBe(20);
  });

  it('sets lastInputTokens to input + cacheRead + cacheWrite', () => {
    useSessionStore.getState().updateUsage({ input: 100, output: 0, cacheRead: 10, cacheWrite: 5 });
    expect(useSessionStore.getState().lastInputTokens).toBe(115);
  });

  it('uses previous lastInputTokens when inputDelta is 0', () => {
    useSessionStore.getState().updateUsage({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 });
    const prev = useSessionStore.getState().lastInputTokens;
    useSessionStore.getState().updateUsage({ input: 0, output: 50, cacheRead: 0, cacheWrite: 0 });
    expect(useSessionStore.getState().lastInputTokens).toBe(prev);
  });
});

// ── addCost ───────────────────────────────────────────────────────

describe('addCost', () => {
  beforeEach(() => resetStore());

  it('accumulates cost', () => {
    useSessionStore.getState().addCost(0.05);
    useSessionStore.getState().addCost(0.10);
    expect(useSessionStore.getState().cost).toBeCloseTo(0.15);
  });
});

// ── startSession ──────────────────────────────────────────────────

describe('startSession', () => {
  beforeEach(() => resetStore());

  it('sets session and startTime', () => {
    const session = makeSession();
    const before = Date.now();
    useSessionStore.getState().startSession(session);
    const state = useSessionStore.getState();
    expect(state.session).toEqual(session);
    expect(state.startTime).toBeGreaterThanOrEqual(before);
  });

  it('resets iteration, lastInputTokens, totalTokens, and cost', () => {
    useSessionStore.setState({
      iteration: { index: 5, max: 10 },
      lastInputTokens: 999,
      cost: 1.5,
      totalTokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    });
    useSessionStore.getState().startSession(makeSession());
    const state = useSessionStore.getState();
    expect(state.iteration).toBe(null);
    expect(state.lastInputTokens).toBe(0);
    expect(state.cost).toBe(0);
    expect(state.totalTokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

// ── endSession ────────────────────────────────────────────────────

describe('endSession', () => {
  beforeEach(() => resetStore());

  it('clears session and startTime', () => {
    useSessionStore.setState({
      session: makeSession(),
      startTime: Date.now(),
      iteration: { index: 3, max: 10 },
    });
    useSessionStore.getState().endSession();
    const state = useSessionStore.getState();
    expect(state.session).toBe(null);
    expect(state.startTime).toBe(null);
    expect(state.iteration).toBe(null);
  });
});

// ── setEnv ────────────────────────────────────────────────────────

describe('setEnv', () => {
  beforeEach(() => resetStore());

  it('sets all env fields', () => {
    useSessionStore.getState().setEnv({
      maxContext: 200_000,
      projectRoot: '/project',
      projectName: 'my-project',
      cwd: '/project/src',
      mode: 'code',
      contextMode: 'frugal',
      inputCost: 3,
      outputCost: 15,
      cacheReadCost: 0.3,
    });
    const state = useSessionStore.getState();
    expect(state.maxContext).toBe(200_000);
    expect(state.projectRoot).toBe('/project');
    expect(state.projectName).toBe('my-project');
    expect(state.cwd).toBe('/project/src');
    expect(state.mode).toBe('code');
    expect(state.contextMode).toBe('frugal');
    expect(state.inputCost).toBe(3);
    expect(state.outputCost).toBe(15);
    expect(state.cacheReadCost).toBe(0.3);
  });

  it('only updates provided fields, keeps existing values for others', () => {
    useSessionStore.setState({
      maxContext: 100_000,
      projectRoot: '/old',
      mode: 'default',
    });
    useSessionStore.getState().setEnv({ projectRoot: '/new' });
    const state = useSessionStore.getState();
    expect(state.projectRoot).toBe('/new');
    expect(state.maxContext).toBe(100_000); // unchanged
    expect(state.mode).toBe('default'); // unchanged
  });
});

// ── setIteration ───────────────────────────────────────────────────

describe('setIteration', () => {
  beforeEach(() => resetStore());

  it('sets iteration', () => {
    useSessionStore.getState().setIteration({ index: 3, max: 10 });
    expect(useSessionStore.getState().iteration).toEqual({ index: 3, max: 10 });
  });

  it('can set iteration to null', () => {
    useSessionStore.setState({ iteration: { index: 3, max: 10 } });
    useSessionStore.getState().setIteration(null);
    expect(useSessionStore.getState().iteration).toBe(null);
  });
});

// ── setModes ──────────────────────────────────────────────────────

describe('setModes', () => {
  beforeEach(() => resetStore());

  it('sets modes', () => {
    const modes = [
      { id: 'default', name: 'Default', description: '' },
      { id: 'code', name: 'Code', description: 'For coding tasks' },
    ];
    useSessionStore.getState().setModes(modes);
    expect(useSessionStore.getState().modes).toEqual(modes);
  });

  it('replaces existing modes', () => {
    useSessionStore.setState({ modes: [{ id: 'old', name: 'Old', description: '' }] });
    useSessionStore.getState().setModes([{ id: 'new', name: 'New', description: '' }]);
    expect(useSessionStore.getState().modes).toHaveLength(1);
    expect(useSessionStore.getState().modes[0].id).toBe('new');
  });
});

// ── setContextModes ────────────────────────────────────────────────

describe('setContextModes', () => {
  beforeEach(() => resetStore());

  it('sets contextModes', () => {
    const modes = [{ id: 'balanced', name: 'Balanced', description: '', thresholds: { warn: 0.5, soft: 0.7, hard: 0.9 } }];
    useSessionStore.getState().setContextModes(modes);
    expect(useSessionStore.getState().contextModes).toEqual(modes);
  });
});

// ── setTodos ──────────────────────────────────────────────────────

describe('setTodos', () => {
  beforeEach(() => resetStore());

  it('sets todos', () => {
    const todos = [
      { id: '1', content: 'Do this', status: 'pending' as const },
      { id: '2', content: 'Do that', status: 'in_progress' as const, activeForm: 'Doing that' },
    ];
    useSessionStore.getState().setTodos(todos);
    expect(useSessionStore.getState().todos).toEqual(todos);
  });

  it('replaces existing todos', () => {
    useSessionStore.setState({ todos: [{ id: 'old', content: 'Old', status: 'pending' as const }] });
    useSessionStore.getState().setTodos([{ id: 'new', content: 'New', status: 'completed' as const }]);
    expect(useSessionStore.getState().todos).toHaveLength(1);
    expect(useSessionStore.getState().todos[0].id).toBe('new');
  });
});
