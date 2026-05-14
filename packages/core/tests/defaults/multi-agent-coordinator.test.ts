import { describe, it, expect, vi } from 'vitest';
import { DefaultMultiAgentCoordinator } from '../../../core/src/defaults/multi-agent-coordinator.js';

describe('DefaultMultiAgentCoordinator', () => {
  const makeConfig = (overrides = {}) => ({
    coordinatorId: 'coord1',
    doneCondition: { type: 'all_tasks_done' as const },
    maxConcurrent: 4,
    ...overrides,
  });

  it('has correct coordinator id', () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    expect(coord.coordinatorId).toBe('coord1');
  });

  it('spawn returns subagent id', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    const result = await coord.spawn({ id: 'agent1', name: 'Agent 1' });
    expect(result.subagentId).toBe('agent1');
    expect(result.agentId).toBe('agent1');
  });

  it('spawn auto-generates id if not provided', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    const result = await coord.spawn({ name: 'Agent' });
    expect(result.subagentId).toBeDefined();
  });

  it('getStatus returns status with done=true when no pending tasks', () => {
    // isDone for all_tasks_done returns true when pendingTasks.length === 0
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    const status = coord.getStatus();
    expect(status.coordinatorId).toBe('coord1');
    expect(status.subagents).toEqual([]);
    expect(status.pendingTasks).toBe(0);
    expect(status.completedTasks).toBe(0);
    expect(status.done).toBe(true); // vacuously true with no tasks
  });

  it('assign queues task', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    await coord.assign({ id: 'task1' });
    const status = coord.getStatus();
    expect(status.pendingTasks).toBe(1);
  });

  it('stop removes subagent', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    await coord.spawn({ id: 'agent1', name: 'A1' });
    await coord.stop('agent1');
    const status = coord.getStatus();
    const agent = status.subagents.find((s) => s.id === 'agent1');
    expect(agent?.status).toBe('stopped');
  });

  it('stopAll stops all subagents', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    await coord.spawn({ id: 'a1', name: 'A1' });
    await coord.spawn({ id: 'a2', name: 'A2' });
    await coord.stopAll();
    const status = coord.getStatus();
    expect(status.subagents.every((s) => s.status === 'stopped')).toBe(true);
  });

  it('delegate throws for unknown subagent', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    await expect(coord.delegate('ghost', { id: '1', type: 'task', from: 'c', payload: {}, timestamp: Date.now(), priority: 'normal' })).rejects.toThrow('not found');
  });

  it('setSubagentBridge wires up subagent', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    await coord.spawn({ id: 'agent1', name: 'A1' });
    const mockBridge = { send: vi.fn().mockResolvedValue(undefined), agentId: 'agent1', coordinatorId: 'coord1', subscribe: vi.fn(), stop: vi.fn(), request: vi.fn() } as any;
    expect(() => coord.setSubagentBridge('agent1', mockBridge)).not.toThrow();
  });

  it('completeTask shifts pending and marks subagent idle', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    await coord.spawn({ id: 'agent1', name: 'A1' });
    await coord.assign({ id: 'task1' });
    coord.completeTask({ subagentId: 'agent1', taskId: 'task1', status: 'success', iterations: 1 });
    const status = coord.getStatus();
    expect(status.completedTasks).toBe(1);
    expect(status.pendingTasks).toBe(0);
  });

  it('emits events', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    const events: any[] = [];
    coord.on('subagent.started', (e) => events.push(e));
    await coord.spawn({ id: 'agent1', name: 'A1' });
    expect(events.some((e) => e.subagent?.id === 'agent1')).toBe(true);
  });

  it('done=true when all_tasks_done and no pending', () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ doneCondition: { type: 'all_tasks_done' } }));
    expect(coord.getStatus().done).toBe(true); // no pending tasks
  });

  it('done=true when maxIterations reached via completeTask', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ doneCondition: { type: 'max_iterations', maxIterations: 1 } }));
    await coord.spawn({ id: 'agent1', name: 'A1' });
    await coord.assign({ id: 'task1' });
    // Simulate task completion which increments totalIterations
    coord.completeTask({ subagentId: 'agent1', taskId: 'task1', status: 'success', iterations: 1 });
    expect(coord.getStatus().done).toBe(true);
  });

  it('does NOT warn on inFlight=0 completion when no runner is wired (caller-driven path)', async () => {
    // The no-runner pattern is intentional: callers drive task lifecycle
    // via completeTask, and runDispatched skips inFlight++ to avoid
    // underflow. The warning that used to fire on every such completion
    // was noise — it should only fire on true double-completion (runner
    // wired but inFlight already at 0).
    const coord = new DefaultMultiAgentCoordinator(makeConfig());
    const warnings: any[] = [];
    coord.on('warning' as any, (e: any) => warnings.push(e));
    await coord.spawn({ id: 'agent1', name: 'A1' });
    await coord.assign({ id: 'task1' });
    coord.completeTask({ subagentId: 'agent1', taskId: 'task1', status: 'success', iterations: 1 });
    expect(warnings.filter((w) => w.type === 'inFlight_underflow')).toHaveLength(0);
  });
});