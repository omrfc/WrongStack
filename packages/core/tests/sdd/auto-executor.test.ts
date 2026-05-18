import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AutoExecutor } from '../../src/sdd/auto-executor.js';
import { EventBus } from '../../src/kernel/events.js';
import { DefaultTaskStore } from '../../src/sdd/task-generator.js';
import { TaskTracker } from '../../src/sdd/task-tracker.js';
import type { TaskNode, TaskGraph } from '../../src/types/task-graph.js';
import type { Specification } from '../../src/types/spec.js';

function makeSpec(): Specification {
  return {
    id: 'spec-1',
    title: 'Test',
    version: '1.0.0',
    status: 'draft',
    overview: 'Overview',
    sections: [],
    requirements: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeNode(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeGraph(nodes: TaskNode[], edges: Array<{ from: string; to: string }> = []): TaskGraph {
  return {
    id: 'graph-1',
    specId: 'spec-1',
    title: 'Test Graph',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: edges.map((e) => ({ id: `${e.from}-${e.to}`, from: e.from, to: e.to, type: 'depends_on' })),
    rootNodes: nodes.filter((n) => !edges.some((e) => e.from === n.id)).map((n) => n.id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('AutoExecutor', () => {
  let store: DefaultTaskStore;
  let tracker: TaskTracker;
  let events: EventBus;

  beforeEach(() => {
    store = new DefaultTaskStore();
    tracker = new TaskTracker({ store });
    events = new EventBus();
  });

  it('executes a single task successfully', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true, output: 'done' }),
    });

    const summary = await executor.execute(graph, makeSpec());
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('handles task failure', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const executor = new AutoExecutor({
      tracker,
      events,
      maxRetries: 0,
      executeTask: async () => ({ success: false, error: 'failed' }),
    });

    const summary = await executor.execute(graph, makeSpec());
    expect(summary.failed).toBe(1);
  });

  it('respects dependency order', async () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const graph = makeGraph([a, b], [{ from: 'b', to: 'a' }]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const executionOrder: string[] = [];
    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async (task) => {
        executionOrder.push(task.id);
        return { success: true };
      },
    });

    await executor.execute(graph, makeSpec());
    expect(executionOrder).toEqual(['a', 'b']);
  });

  it('retries failed tasks', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    let attempts = 0;
    const executor = new AutoExecutor({
      tracker,
      events,
      maxRetries: 2,
      executeTask: async () => {
        attempts++;
        if (attempts < 3) return { success: false, retry: true };
        return { success: true };
      },
    });

    const summary = await executor.execute(graph, makeSpec());
    expect(summary.completed).toBe(1);
    expect(summary.retried).toBeGreaterThan(0);
  });

  it('calls onTaskStart and onTaskComplete', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const onStart = vi.fn();
    const onComplete = vi.fn();

    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true }),
      onTaskStart: onStart,
      onTaskComplete: onComplete,
    });

    await executor.execute(graph, makeSpec());
    expect(onStart).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  it('calls onDone with summary', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const onDone = vi.fn();
    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true }),
      onDone,
    });

    await executor.execute(graph, makeSpec());
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 1,
        completed: 1,
        failed: 0,
      }),
    );
  });

  it('stops execution when stop() called', async () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const graph = makeGraph(nodes);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    let executed = 0;
    const executor = new AutoExecutor({
      tracker,
      events,
      maxConcurrent: 1,
      executeTask: async () => {
        executed++;
        if (executed === 1) executor.stop();
        return { success: true };
      },
    });

    await executor.execute(graph, makeSpec());
    // Should have stopped after first task
    expect(executed).toBeLessThanOrEqual(2);
  });

  it('handles empty graph', async () => {
    const graph = makeGraph([]);
    await store.saveGraph(graph);

    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true }),
    });

    const summary = await executor.execute(graph, makeSpec());
    expect(summary.total).toBe(0);
    expect(summary.completed).toBe(0);
  });
});
