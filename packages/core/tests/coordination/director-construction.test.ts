import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetBus } from '../../src/coordination/fleet-bus.js';
import { wireBudgetHandler, wireTaskCompletedListener, type DirectorInternals } from '../../src/coordination/director-construction.js';

const tick = () => new Promise((r) => setImmediate(r));

function makeInternals(over: Partial<DirectorInternals> = {}): DirectorInternals {
  return {
    id: 'd1',
    completed: new Map(),
    taskWaiters: new Map(),
    taskDescriptions: new Map(),
    stateCheckpoint: null,
    usage: { snapshot: () => ({ total: { cost: 0 } }) } as never,
    fleetManager: undefined,
    fleet: new FleetBus(),
    coordinator: { on: vi.fn(), off: vi.fn() } as never,
    maxBudgetExtensions: 5,
    maxFleetCostUsd: Number.POSITIVE_INFINITY,
    recordExtension: vi.fn(),
    appendSessionEvent: vi.fn(async () => {}),
    scheduleManifest: vi.fn(),
    brain: undefined,
    ...over,
  };
}

const result = (over: Record<string, unknown> = {}) => ({ taskId: 't1', subagentId: 's1', status: 'success', iterations: 1, toolCalls: 2, durationMs: 5, ...over });

afterEach(() => vi.restoreAllMocks());

describe('wireTaskCompletedListener', () => {
  it('records a successful task, resolves its waiter, and schedules the manifest', () => {
    const d = makeInternals();
    const resolve = vi.fn();
    d.taskWaiters.set('t1', { promise: Promise.resolve(result() as never), resolve });
    d.taskDescriptions.set('t1', 'My task');
    const listener = wireTaskCompletedListener(d);
    listener({ task: { description: 'fallback' } as never, result: result() as never });
    expect(d.completed.get('t1')).toBeDefined();
    expect(resolve).toHaveBeenCalled();
    expect(d.taskWaiters.has('t1')).toBe(false);
    expect(d.scheduleManifest).toHaveBeenCalled();
    expect(d.appendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_completed', title: 'My task' }));
    expect(d.coordinator.on).toHaveBeenCalledWith('task.completed', listener);
  });

  it('mirrors a failed task into the checkpoint + session stream and flushes via FleetManager', () => {
    const stateCheckpoint = { recordTaskStatus: vi.fn(), setUsage: vi.fn() };
    const fleetManager = { flushManifest: vi.fn() };
    const d = makeInternals({ stateCheckpoint: stateCheckpoint as never, fleetManager: fleetManager as never });
    const listener = wireTaskCompletedListener(d);
    listener({ task: { description: 'y' } as never, result: result({ taskId: 't2', status: 'failed', error: { kind: 'boom', message: 'bad' } }) as never });
    expect(stateCheckpoint.recordTaskStatus).toHaveBeenCalledWith('t2', expect.objectContaining({ status: 'failed', error: 'boom: bad' }));
    expect(stateCheckpoint.setUsage).toHaveBeenCalled();
    expect(fleetManager.flushManifest).toHaveBeenCalled();
    expect(d.appendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_failed' }));
  });

  it('falls back to task.description then taskId for the title, with no error string', () => {
    const d = makeInternals();
    const listener = wireTaskCompletedListener(d);
    // no taskDescriptions entry → uses payload.task.description
    listener({ task: { description: 'from-task' } as never, result: result({ taskId: 't3', status: 'timeout' }) as never });
    expect(d.appendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_failed', title: 'from-task', error: 'timeout' }));
  });
});

describe('wireBudgetHandler', () => {
  const emit = (d: DirectorInternals, subagentId: string, kind: string, over: Record<string, unknown> = {}) => {
    const cap = { extended: null as Record<string, unknown> | null, denied: false };
    (d.fleet as never as { emit: (e: unknown) => void }).emit({
      subagentId,
      taskId: 'task-1',
      ts: Date.now(),
      type: 'budget.threshold_reached',
      payload: { kind, used: 11, limit: 10, timeoutMs: 1000, extend: (e: Record<string, unknown>) => { cap.extended = e; }, deny: () => { cap.denied = true; }, ...over },
    });
    return cap;
  };
  const bumpProgress = (d: DirectorInternals, subagentId: string) =>
    (d.fleet as never as { emit: (e: unknown) => void }).emit({ subagentId, ts: Date.now(), type: 'tool.executed', payload: {} });

  it('ignores collab subagents', () => {
    const d = makeInternals();
    wireBudgetHandler(d);
    const cap = emit(d, 'bug-hunter-1', 'iterations');
    expect(cap.denied).toBe(false);
    expect(cap.extended).toBeNull();
  });

  it('extends a timeout while progress is made and denies a stuck agent', async () => {
    const d = makeInternals();
    wireBudgetHandler(d);
    bumpProgress(d, 's1');
    const first = emit(d, 's1', 'timeout');
    await tick();
    expect(first.extended?.timeoutMs).toBeGreaterThan(0);
    const second = emit(d, 's1', 'timeout'); // no new progress
    expect(second.denied).toBe(true);
  });

  it('extends an idle_timeout kind onto idleTimeoutMs', async () => {
    const d = makeInternals();
    wireBudgetHandler(d);
    bumpProgress(d, 's2');
    const cap = emit(d, 's2', 'idle_timeout');
    await tick();
    expect(cap.extended?.idleTimeoutMs).toBeGreaterThan(0);
  });

  it('denies once the per-kind extension cap is reached', () => {
    const d = makeInternals({ maxBudgetExtensions: 0 });
    wireBudgetHandler(d);
    expect(emit(d, 's3', 'iterations').denied).toBe(true);
  });

  it('denies a cost extension when the fleet cost cap is exceeded', () => {
    const d = makeInternals({ maxFleetCostUsd: 1, usage: { snapshot: () => ({ total: { cost: 5 } }) } as never });
    wireBudgetHandler(d);
    expect(emit(d, 's4', 'cost').denied).toBe(true);
  });

  it('grants an extension for each non-timeout kind (no brain)', async () => {
    for (const [kind, field] of [['iterations', 'maxIterations'], ['tool_calls', 'maxToolCalls'], ['tokens', 'maxTokens'], ['cost', 'maxCostUsd']] as const) {
      const d = makeInternals();
      wireBudgetHandler(d);
      const cap = emit(d, 's5', kind);
      await tick();
      expect(cap.extended?.[field]).toBeGreaterThan(0);
      expect(d.recordExtension).toHaveBeenCalled();
    }
  });

  it('routes through the brain: deny / ask_human / stop / extend / throw', async () => {
    const brainDecision = (decide: () => Promise<unknown>) => makeInternals({ brain: { decide } as never });

    const denyCap = (() => { const d = brainDecision(async () => ({ type: 'deny' })); wireBudgetHandler(d); return emit(d, 'a', 'iterations'); })();
    await tick(); await tick();
    expect(denyCap.denied).toBe(true);

    const askCap = (() => { const d = brainDecision(async () => ({ type: 'ask_human' })); wireBudgetHandler(d); return emit(d, 'b', 'iterations'); })();
    await tick(); await tick();
    expect(askCap.denied).toBe(true);

    const stopCap = (() => { const d = brainDecision(async () => ({ type: 'answer', optionId: 'stop', text: 'stop' })); wireBudgetHandler(d); return emit(d, 'c', 'iterations'); })();
    await tick(); await tick();
    expect(stopCap.denied).toBe(true);

    const extendCap = (() => { const d = brainDecision(async () => ({ type: 'answer', optionId: 'extend', text: 'go' })); wireBudgetHandler(d); return emit(d, 'd', 'tool_calls'); })();
    await tick(); await tick();
    expect(extendCap.extended?.maxToolCalls).toBeGreaterThan(0);

    const throwCap = (() => { const d = brainDecision(async () => { throw new Error('brain down'); }); wireBudgetHandler(d); return emit(d, 'e', 'iterations'); })();
    await tick(); await tick();
    expect(throwCap.denied).toBe(true);
  });
});
