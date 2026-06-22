import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeAskResultTool,
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeFleetHealthTool,
  makeFleetSessionTool,
  makeFleetStatusTool,
  makeFleetUsageTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateAllTool,
  makeTerminateTool,
  makeWorkCompleteTool,
} from '../../src/coordination/director-tools.js';
import { FleetCostCapError, FleetSpawnBudgetError, type Director } from '../../src/coordination/director.js';

const dispatchAgentMock = vi.fn();
vi.mock('../../src/coordination/dispatcher.js', () => ({
  dispatchAgent: (...a: unknown[]) => dispatchAgentMock(...a),
}));

type MockDirector = Record<string, ReturnType<typeof vi.fn> | unknown>;

let director: MockDirector;
const asDir = () => director as never as Director;

beforeEach(() => {
  director = {
    id: 'dir1',
    dispatchClassifier: undefined,
    largeAnswerStore: { storeAnswer: vi.fn(), retrieveAnswer: vi.fn() },
    fleetManager: {
      getFleetStats: vi.fn(() => ({ total: 2, running: 1, idle: 1, stopped: 0 })),
      getFleetStatus: vi.fn(() => ({ pending: ['t1'] })),
      snapshot: vi.fn(() => ({ totalCost: 0.5 })),
    },
    fleet: { emit: vi.fn() },
    spawn: vi.fn(async () => 'sub-1'),
    assign: vi.fn(async () => 'task-1'),
    awaitTasks: vi.fn(async () => [{ taskId: 't', status: 'done' }]),
    ask: vi.fn(async () => 'the answer'),
    rollUp: vi.fn(() => 'rolled up'),
    terminate: vi.fn(async () => {}),
    terminateAll: vi.fn(async () => {}),
    status: vi.fn(() => ({ subagents: [{ id: 's1', status: 'running' }] })),
    snapshot: vi.fn(() => ({ perSubagent: { s1: { iterations: 3, toolCalls: 5, cost: 0.2, lastEventAt: 'ts' } } })),
    readSession: vi.fn(async () => ({ lastText: 'hi', stopReason: 'end', toolUses: 1 })),
    spawnCollab: vi.fn(async () => ({ sessionId: 'cs1', overallVerdict: 'approve', bugs: [], refactorPlans: [], evaluations: [], summary: 'ok' })),
    workComplete: vi.fn(),
  };
  dispatchAgentMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('makeSpawnTool', () => {
  it('spawns from a roster role and applies config overrides', async () => {
    const tool = makeSpawnTool(asDir(), { planner: { name: 'Planner', role: 'planner' } });
    const res = await tool.execute({
      role: 'planner', name: 'P2', provider: 'openai', model: 'gpt-5', systemPromptOverride: 'extra',
      maxIterations: 5, maxToolCalls: 10, maxCostUsd: 1, timeoutMs: 1000, idleTimeoutMs: 500, maxTokens: 2000,
    }, {} as never, {} as never);
    expect(res).toMatchObject({ subagentId: 'sub-1', name: 'P2', provider: 'openai', model: 'gpt-5' });
    expect(director.spawn).toHaveBeenCalled();
  });

  it('errors on an unknown roster role', async () => {
    const tool = makeSpawnTool(asDir(), { planner: {} as never });
    const res = (await tool.execute({ role: 'nope' }, {} as never, {} as never)) as { error: string };
    expect(res.error).toMatch(/unknown role/);
  });

  it('dispatches by description to a matching roster entry', async () => {
    dispatchAgentMock.mockResolvedValue({ role: 'coder', definition: { config: {} } });
    const tool = makeSpawnTool(asDir(), { coder: { name: 'Coder', role: 'coder' } });
    const res = await tool.execute({ description: 'fix the bug' }, {} as never, {} as never);
    expect(res).toMatchObject({ subagentId: 'sub-1' });
  });

  it('dispatches by description to a catalog definition when no roster entry exists', async () => {
    dispatchAgentMock.mockResolvedValue({ role: 'researcher', definition: { config: { name: 'R', provider: 'anthropic', model: 'claude' } } });
    const tool = makeSpawnTool(asDir(), {});
    const res = await tool.execute({ description: 'research this' }, {} as never, {} as never);
    expect(res).toMatchObject({ subagentId: 'sub-1', model: 'claude' });
  });

  it('falls back to a name-only config', async () => {
    const tool = makeSpawnTool(asDir());
    await tool.execute({ name: 'bare' }, {} as never, {} as never);
    expect(director.spawn).toHaveBeenCalledWith(expect.objectContaining({ name: 'bare' }));
  });

  it('surfaces FleetSpawnBudgetError, FleetCostCapError, and generic errors', async () => {
    const tool = makeSpawnTool(asDir());
    (director.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new FleetSpawnBudgetError('max_spawns', 3, 4));
    expect((await tool.execute({ name: 'x' }, {} as never, {} as never)) as { kind: string }).toMatchObject({ kind: 'max_spawns', limit: 3, observed: 4 });
    (director.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new FleetCostCapError(10, 12));
    expect((await tool.execute({ name: 'x' }, {} as never, {} as never)) as { error: string }).toHaveProperty('error');
    (director.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect((await tool.execute({ name: 'x' }, {} as never, {} as never)) as { error: string }).toMatchObject({ error: 'boom' });
  });
});

describe('task/ask tools', () => {
  it('assign_task creates a task', async () => {
    const res = await makeAssignTool(asDir()).execute({ subagentId: 's1', description: 'do it' }, {} as never, {} as never);
    expect(res).toMatchObject({ taskId: 'task-1', subagentId: 's1' });
  });

  it('await_tasks returns results', async () => {
    const res = await makeAwaitTasksTool(asDir()).execute({ taskIds: ['t'] }, {} as never, {} as never);
    expect(res).toMatchObject({ results: [{ taskId: 't' }] });
  });

  it('ask_subagent returns an inline answer', async () => {
    (director.largeAnswerStore as { storeAnswer: ReturnType<typeof vi.fn> }).storeAnswer.mockReturnValue({ inline: true, summary: 'short' });
    const res = await makeAskTool(asDir()).execute({ subagentId: 's1', question: 'q?' }, {} as never, {} as never);
    expect(res).toMatchObject({ ok: true, answer: 'short' });
  });

  it('ask_subagent stores a large answer out-of-band', async () => {
    (director.largeAnswerStore as { storeAnswer: ReturnType<typeof vi.fn> }).storeAnswer.mockReturnValue({ inline: false, summary: 'sum', key: 'k1' });
    const res = (await makeAskTool(asDir()).execute({ subagentId: 's1', question: 'q?' }, {} as never, {} as never)) as { _answerKey: string };
    expect(res._answerKey).toBe('k1');
  });

  it('ask_subagent returns an error on failure', async () => {
    (director.ask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ask failed'));
    const res = (await makeAskTool(asDir()).execute({ subagentId: 's1', question: 'q?' }, {} as never, {} as never)) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('ask_result retrieves and reports missing keys', async () => {
    (director.largeAnswerStore as { retrieveAnswer: ReturnType<typeof vi.fn> }).retrieveAnswer.mockReturnValueOnce('full value');
    expect(await makeAskResultTool(asDir()).execute({ key: 'k1' }, {} as never, {} as never)).toMatchObject({ ok: true, value: 'full value' });
    (director.largeAnswerStore as { retrieveAnswer: ReturnType<typeof vi.fn> }).retrieveAnswer.mockReturnValueOnce(undefined);
    expect(await makeAskResultTool(asDir()).execute({ key: 'missing' }, {} as never, {} as never)).toMatchObject({ ok: false });
  });

  it('roll_up aggregates results', async () => {
    expect(await makeRollUpTool(asDir()).execute({ taskIds: ['a', 'b'] }, {} as never, {} as never)).toMatchObject({ summary: 'rolled up', count: 2 });
  });
});

describe('lifecycle/status tools', () => {
  it('terminate and terminate_all', async () => {
    expect(await makeTerminateTool(asDir()).execute({ subagentId: 's1' }, {} as never, {} as never)).toMatchObject({ ok: true });
    expect(await makeTerminateAllTool(asDir()).execute({}, {} as never, {} as never)).toMatchObject({ ok: true });
    expect(director.terminateAll).toHaveBeenCalled();
  });

  it('fleet_status with and without a fleet manager', async () => {
    const res = await makeFleetStatusTool(asDir()).execute({}, {} as never, {} as never);
    expect(res).toMatchObject({ coordinatorStats: { total: 2 }, pending: ['t1'] });
    director.fleetManager = undefined;
    const res2 = (await makeFleetStatusTool(asDir()).execute({}, {} as never, {} as never)) as { coordinatorStats: unknown };
    expect(res2.coordinatorStats).toBeUndefined();
  });

  it('fleet_usage returns the snapshot', async () => {
    expect(await makeFleetUsageTool(asDir()).execute({}, {} as never, {} as never)).toMatchObject({ perSubagent: expect.any(Object) });
  });

  it('fleet_session returns a transcript or an error when unavailable', async () => {
    expect(await makeFleetSessionTool(asDir()).execute({ subagentId: 's1' }, {} as never, {} as never)).toMatchObject({ lastText: 'hi' });
    (director.readSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect((await makeFleetSessionTool(asDir()).execute({ subagentId: 's1' }, {} as never, {} as never)) as { error: string }).toHaveProperty('error');
  });

  it('fleet_health maps per-subagent budget pressure', async () => {
    const res = (await makeFleetHealthTool(asDir()).execute({}, {} as never, {} as never)) as { subagents: Array<{ id: string; budgetPressure: { iterations: number } }> };
    expect(res.subagents[0]).toMatchObject({ id: 's1', budgetPressure: { iterations: 3, toolCalls: 5 } });
  });

  it('fleet_emit emits an event on the bus', async () => {
    await makeFleetEmitTool(asDir()).execute({ type: 'bug.found', payload: { x: 1 } }, {} as never, {} as never);
    expect((director.fleet as { emit: ReturnType<typeof vi.fn> }).emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bug.found', subagentId: 'dir1' }));
  });

  it('work_complete signals wind-down', async () => {
    expect(await makeWorkCompleteTool(asDir()).execute({}, {} as never, {} as never)).toMatchObject({ ok: true });
    expect(director.workComplete).toHaveBeenCalled();
  });
});

describe('collab_debug tool', () => {
  it('rejects empty targetPaths', async () => {
    expect((await makeCollabDebugTool(asDir()).execute({ targetPaths: [] }, {} as never, {} as never)) as { error: string }).toHaveProperty('error');
  });

  it('runs a collaborative debug session', async () => {
    const res = await makeCollabDebugTool(asDir()).execute({ targetPaths: ['src/a.ts'], timeoutMs: 1000 }, {} as never, {} as never);
    expect(res).toMatchObject({ sessionId: 'cs1', overallVerdict: 'approve', bugCount: 0 });
  });

  it('reports a failure from spawnCollab', async () => {
    (director.spawnCollab as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('collab boom'));
    expect((await makeCollabDebugTool(asDir()).execute({ targetPaths: ['x'] }, {} as never, {} as never)) as { error: string }).toMatchObject({ error: expect.stringContaining('collab boom') });
  });
});
