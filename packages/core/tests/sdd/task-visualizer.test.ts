import { describe, expect, it } from 'vitest';
import {
  renderTaskGraph,
  renderProgress,
  renderTaskList,
} from '../../src/sdd/task-visualizer.js';
import { computeTaskProgress } from '../../src/types/task-graph.js';
import type { TaskGraph, TaskNode } from '../../src/types/task-graph.js';

function makeNode(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: 'Description for task',
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

describe('Task Visualizer', () => {
  it('renders a graph with header', () => {
    const graph = makeGraph([makeNode('a')]);
    const output = renderTaskGraph(graph);
    expect(output).toContain('Task Graph: Test Graph');
    expect(output).toContain('Nodes: 1');
  });

  it('renders progress bar', () => {
    const graph = makeGraph([
      makeNode('a', { status: 'completed' }),
      makeNode('b'),
    ]);
    const progress = computeTaskProgress(graph);
    const output = renderProgress(progress);
    expect(output).toContain('Progress:');
    expect(output).toContain('50%');
  });

  it('renders task list grouped by status', () => {
    const graph = makeGraph([
      makeNode('a', { status: 'completed' }),
      makeNode('b', { status: 'in_progress' }),
      makeNode('c'),
    ]);
    const output = renderTaskList(graph);
    expect(output).toContain('COMPLETED');
    expect(output).toContain('IN_PROGRESS');
    expect(output).toContain('PENDING');
  });

  it('renders compact mode', () => {
    const graph = makeGraph([makeNode('a', { title: 'A very long task title that should be truncated in compact mode' })]);
    const output = renderTaskGraph(graph, { compact: true });
    expect(output).toContain('…');
  });

  it('renders dependency arrows', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b')],
      [{ from: 'b', to: 'a' }],
    );
    const output = renderTaskGraph(graph);
    // Should show that b depends on a
    expect(output).toContain('Task a');
    expect(output).toContain('Task b');
  });

  it('renders empty graph', () => {
    const graph = makeGraph([]);
    const output = renderTaskGraph(graph);
    expect(output).toContain('Nodes: 0');
  });

  it('renders legend', () => {
    const graph = makeGraph([makeNode('a')]);
    const output = renderTaskGraph(graph);
    expect(output).toContain('Legend:');
  });

  it('renders mixed statuses', () => {
    const graph = makeGraph([
      makeNode('a', { status: 'completed' }),
      makeNode('b', { status: 'in_progress' }),
      makeNode('c', { status: 'blocked' }),
      makeNode('d', { status: 'failed' }),
      makeNode('e', { status: 'review' }),
    ]);
    const output = renderTaskList(graph);
    expect(output).toContain('COMPLETED');
    expect(output).toContain('IN_PROGRESS');
    expect(output).toContain('BLOCKED');
    expect(output).toContain('FAILED');
    expect(output).toContain('REVIEW');
  });
});
