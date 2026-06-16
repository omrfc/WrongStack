import { describe, expect, it, vi } from 'vitest';
import * as fleetSpawn from '../../src/coordination/fleet-spawn.js';
import type { DirectorFleetHost } from '../../src/coordination/fleet-spawn.js';
import { InMemoryBridgeTransport } from '../../src/coordination/in-memory-transport.js';
import {
  FleetSpawnBudgetError,
  FleetCostCapError,
  FleetContextOverflowError,
} from '../../src/coordination/director/director-errors.js';
import type { SubagentConfig, TaskResult, TaskSpec } from '../../src/types/multi-agent.js';

function makeHost(overrides: Partial<DirectorFleetHost> = {}): DirectorFleetHost {
  const transport = new InMemoryBridgeTransport();
  const coordinator = {
    spawn: vi.fn(async (c: SubagentConfig) => ({ subagentId: `sub-${c.name ?? 'x'}` })),
    assign: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    setSubagentBridge: vi.fn(),
  };
  const host: DirectorFleetHost = {
    id: 'director-1',
    coordinator: coordinator as never,
    fleet: { emit: vi.fn() } as never,
    transport: transport as never,
    stateCheckpoint: { recordSpawn: vi.fn(), recordTaskAssigned: vi.fn() } as never,
    workCompleteFlag: false,
    spawnCount: 0,
    maxSpawns: 10,
    maxSpawnDepth: 5,
    spawnDepth: 0,
    maxFleetCostUsd: Number.POSITIVE_INFINITY,
    maxLeaderContextLoad: 1.0,
    leaderContextPressure: 0,
    modelMatrix: undefined,
    usage: { snapshot: vi.fn(() => ({ total: { cost: 0 } })), removeSubagent: vi.fn() } as never,
    fleetManager: undefined,
    manifestEntries: new Map(),
    completed: new Map(),
    subagentBridges: new Map(),
    taskWaiters: new Map(),
    subagentMeta: new Map(),
    taskDescriptions: new Map(),
    taskOwners: new Map(),
    priceLookups: new Map(),
    _usedNicknames: new Set(),
    appendSessionEvent: vi.fn(async () => {}),
    scheduleManifest: vi.fn(),
    resolveMaxContext: vi.fn(() => 100_000),
    ...overrides,
  };
  return host;
}

const cfg = (over: Partial<SubagentConfig> = {}): SubagentConfig =>
  ({ name: 'worker', role: 'hunter', provider: 'anthropic', model: 'claude', ...over }) as SubagentConfig;

describe('fleet-spawn spawn()', () => {
  it('refuses to spawn once workComplete() has been called', async () => {
    const host = makeHost({ workCompleteFlag: true });
    await expect(fleetSpawn.spawn(host, cfg())).rejects.toBeInstanceOf(FleetSpawnBudgetError);
    expect(host.coordinator.spawn).not.toHaveBeenCalled();
  });

  it('resolves a model from the matrix when the config did not pin one', async () => {
    const host = makeHost({ modelMatrix: { hunter: { model: 'matrix-model', provider: 'matrix-prov' } } as never });
    const config = cfg({ model: undefined, provider: undefined });
    await fleetSpawn.spawn(host, config);
    expect(config.model).toBe('matrix-model');
    expect(config.provider).toBe('matrix-prov');
  });

  it('spawns inline (no FleetManager), recording counters, meta, manifest and price lookup', async () => {
    const host = makeHost();
    const id = await fleetSpawn.spawn(host, cfg({ name: 'Ada' }), { input: 1, output: 2 });
    expect(id).toBe('sub-Ada');
    expect(host.spawnCount).toBe(1);
    expect(host.subagentMeta.get('sub-Ada')).toEqual({ provider: 'anthropic', model: 'claude' });
    expect(host.priceLookups.get('anthropic/claude')).toEqual({ input: 1, output: 2 });
    expect(host.manifestEntries.has('sub-Ada')).toBe(true);
    expect(host.subagentBridges.has('sub-Ada')).toBe(true);
    expect(host.coordinator.setSubagentBridge).toHaveBeenCalled();
    expect(host.fleet.emit).toHaveBeenCalled();
    expect(host.stateCheckpoint?.recordSpawn).toHaveBeenCalled();
    expect(host.appendSessionEvent).toHaveBeenCalled();
    expect(host.scheduleManifest).toHaveBeenCalled();
  });

  it('assigns a nickname when the name is a synthetic default (inline)', async () => {
    const host = makeHost();
    const config = cfg({ name: 'adhoc' });
    await fleetSpawn.spawn(host, config);
    expect(config.name).not.toBe('adhoc'); // upgraded to a memorable nickname
    expect(host._usedNicknames.size).toBe(1);
  });

  it('keeps an explicit, non-default name untouched', async () => {
    const host = makeHost();
    const config = cfg({ name: 'Reviewer', role: 'reviewer' });
    await fleetSpawn.spawn(host, config);
    expect(config.name).toBe('Reviewer');
    expect(host._usedNicknames.size).toBe(0);
  });

  it('enforces inline spawn-depth, spawn-count, cost and context caps', async () => {
    await expect(fleetSpawn.spawn(makeHost({ spawnDepth: 5, maxSpawnDepth: 5 }), cfg())).rejects.toBeInstanceOf(FleetSpawnBudgetError);
    await expect(fleetSpawn.spawn(makeHost({ spawnCount: 10, maxSpawns: 10 }), cfg())).rejects.toBeInstanceOf(FleetSpawnBudgetError);
    await expect(
      fleetSpawn.spawn(
        makeHost({ maxFleetCostUsd: 5, usage: { snapshot: () => ({ total: { cost: 9 } }), removeSubagent: vi.fn() } as never }),
        cfg(),
      ),
    ).rejects.toBeInstanceOf(FleetCostCapError);
    await expect(
      fleetSpawn.spawn(makeHost({ maxLeaderContextLoad: 0.5, leaderContextPressure: 99_000 }), cfg()),
    ).rejects.toBeInstanceOf(FleetContextOverflowError);
  });

  it('delegates spawn bookkeeping to FleetManager when present', async () => {
    const fleetManager = {
      canSpawn: vi.fn(() => null),
      assignNicknameAndRecord: vi.fn(),
      recordSpawn: vi.fn(),
      removeSubagent: vi.fn(),
    };
    const host = makeHost({ fleetManager: fleetManager as never });
    await fleetSpawn.spawn(host, cfg({ name: 'subagent' }), { input: 1 });
    expect(fleetManager.assignNicknameAndRecord).toHaveBeenCalled();
    expect(fleetManager.recordSpawn).toHaveBeenCalled();
    expect(host.spawnCount).toBe(0); // FleetManager owns the counter
    expect(host.manifestEntries.size).toBe(0); // FleetManager owns the manifest
  });

  it('maps every FleetManager rejection kind to its error type', async () => {
    const mk = (kind: string) =>
      makeHost({ fleetManager: { canSpawn: () => ({ kind, limit: 1, observed: 2 }), assignNicknameAndRecord: vi.fn(), recordSpawn: vi.fn(), removeSubagent: vi.fn() } as never });
    await expect(fleetSpawn.spawn(mk('max_spawn_depth'), cfg())).rejects.toBeInstanceOf(FleetSpawnBudgetError);
    await expect(fleetSpawn.spawn(mk('max_spawns'), cfg())).rejects.toBeInstanceOf(FleetSpawnBudgetError);
    await expect(fleetSpawn.spawn(mk('max_cost_usd'), cfg())).rejects.toBeInstanceOf(FleetCostCapError);
    await expect(fleetSpawn.spawn(mk('max_context_load'), cfg())).rejects.toBeInstanceOf(FleetContextOverflowError);
  });
});

describe('fleet-spawn assign()', () => {
  const noopDesc = vi.fn();
  const noopOwner = vi.fn();

  it('synthesizes an aborted result and resolves a waiter when work is complete', async () => {
    const host = makeHost({ workCompleteFlag: true });
    let resolved: TaskResult | undefined;
    host.taskWaiters.set('t1', { promise: Promise.resolve() as never, resolve: (r) => { resolved = r; } });
    const id = await fleetSpawn.assign(host, { description: 'x' } as TaskSpec, 't1', noopDesc, noopOwner);
    expect(id).toBe('t1');
    expect(host.completed.get('t1')?.status).toBe('stopped');
    expect(resolved?.error?.kind).toBe('aborted_by_parent');
    expect(host.taskWaiters.has('t1')).toBe(false);
  });

  it('handles work-complete with no pending waiter', async () => {
    const host = makeHost({ workCompleteFlag: true });
    const id = await fleetSpawn.assign(host, { id: 't2', description: 'x' } as TaskSpec, 't2', noopDesc, noopOwner);
    expect(id).toBe('t2');
    expect(host.completed.has('t2')).toBe(true);
  });

  it('dispatches a task, pushing the taskId onto the owning manifest entry', async () => {
    const host = makeHost();
    host.manifestEntries.set('sub-1', { taskIds: [] });
    const id = await fleetSpawn.assign(
      host,
      { subagentId: 'sub-1', description: 'do it' } as TaskSpec,
      'task-9',
      noopDesc,
      noopOwner,
    );
    expect(id).toBe('task-9');
    expect((host.manifestEntries.get('sub-1') as { taskIds: string[] }).taskIds).toContain('task-9');
    expect(host.coordinator.assign).toHaveBeenCalled();
    expect(noopDesc).toHaveBeenCalledWith('task-9', 'do it');
    expect(noopOwner).toHaveBeenCalledWith('task-9', 'sub-1');
    expect(host.stateCheckpoint?.recordTaskAssigned).toHaveBeenCalled();
    expect(host.scheduleManifest).toHaveBeenCalled();
  });

  it('dispatches a task whose subagent has no manifest entry and preserves an existing id', async () => {
    const host = makeHost();
    const id = await fleetSpawn.assign(
      host,
      { id: 'keep-me', subagentId: 'ghost', description: undefined } as TaskSpec,
      'ignored',
      noopDesc,
      noopOwner,
    );
    expect(id).toBe('keep-me');
  });
});

describe('fleet-spawn awaitTasks()', () => {
  it('returns cached results, existing waiter promises, and creates fresh waiters', async () => {
    const host = makeHost();
    const cached: TaskResult = { subagentId: 's', taskId: 'a', status: 'completed', iterations: 0, toolCalls: 0, durationMs: 0 };
    host.completed.set('a', cached);
    const existingPromise = Promise.resolve({ taskId: 'b' } as TaskResult);
    host.taskWaiters.set('b', { promise: existingPromise, resolve: vi.fn() });

    const pending = fleetSpawn.awaitTasks(host, ['a', 'b', 'c']);
    expect(host.taskWaiters.has('c')).toBe(true); // fresh waiter created
    // resolve the fresh one so the Promise.all settles
    host.taskWaiters.get('c')?.resolve({ taskId: 'c' } as TaskResult);
    const results = await pending;
    expect(results.map((r) => r.taskId)).toEqual(['a', 'b', 'c']);
  });
});

describe('fleet-spawn terminate/terminateAll/remove()', () => {
  it('delegates terminate and terminateAll to the coordinator', async () => {
    const host = makeHost();
    await fleetSpawn.terminate(host, 'sub-1');
    await fleetSpawn.terminateAll(host);
    expect(host.coordinator.stop).toHaveBeenCalledWith('sub-1');
    expect(host.coordinator.stopAll).toHaveBeenCalled();
  });

  it('removes a subagent inline, stopping its bridge and freeing the nickname', async () => {
    const host = makeHost();
    // seed a spawned subagent so the bridge + manifest exist
    await fleetSpawn.spawn(host, cfg({ name: 'Ada' }));
    host.manifestEntries.set('sub-Ada', { name: 'Einstein (Bug Hunter)' });
    host._usedNicknames.add('einstein');
    await fleetSpawn.remove(host, 'sub-Ada');
    expect(host.coordinator.remove).toHaveBeenCalledWith('sub-Ada');
    expect(host.usage.removeSubagent).toHaveBeenCalledWith('sub-Ada');
    expect(host.subagentBridges.has('sub-Ada')).toBe(false);
    expect(host.manifestEntries.has('sub-Ada')).toBe(false);
    expect(host._usedNicknames.has('einstein')).toBe(false);
  });

  it('removes a subagent with no bridge and no nameable manifest entry', async () => {
    const host = makeHost();
    host.manifestEntries.set('sub-x', {}); // entry without a name
    await fleetSpawn.remove(host, 'sub-x');
    expect(host.manifestEntries.has('sub-x')).toBe(false);
  });

  it('delegates nickname cleanup to FleetManager on remove when present', async () => {
    const fleetManager = { removeSubagent: vi.fn(), canSpawn: vi.fn(), assignNicknameAndRecord: vi.fn(), recordSpawn: vi.fn() };
    const host = makeHost({ fleetManager: fleetManager as never });
    await fleetSpawn.remove(host, 'sub-1');
    expect(fleetManager.removeSubagent).toHaveBeenCalledWith('sub-1');
  });
});
