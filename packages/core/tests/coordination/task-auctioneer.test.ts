import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TaskAuctioneer } from '../../src/coordination/task-auctioneer.js';
import type { GoalNode, KnowledgeGraph } from '../../src/coordination/knowledge-graph.js';
import type { FleetBus } from '../../src/coordination/fleet-bus.js';
import type { Mailbox } from '../../src/coordination/mailbox-types.js';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function createMockGraph(): KnowledgeGraph {
  const nodes = new Map<string, GoalNode>();

  return {
    add: vi.fn(async (data: Record<string, unknown>) => {
      const id = `goal_${nodes.size + 1}`;
      const node: GoalNode = {
        id,
        type: 'goal',
        title: String(data.title ?? 'Untitled'),
        description: String(data.description ?? ''),
        status: String(data.status ?? 'pending') as GoalNode['status'],
        priority: String(data.priority ?? 'medium') as GoalNode['priority'],
        assignee: data.assignee as string | undefined,
        blockedBy: (data.blockedBy as string[]) ?? [],
        dependsOn: (data.dependsOn as string[]) ?? [],
        createdBy: String(data.createdBy ?? ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: (data.tags as string[]) ?? [],
        children: (data.children as string[]) ?? [],
        parentGoal: data.parentGoal as string | undefined,
      } as GoalNode;
      nodes.set(id, node);
      return node;
    }),
    get: vi.fn((id: string) => {
      return nodes.get(id);
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const node = nodes.get(id);
      if (!node) return null;
      Object.assign(node, patch as Partial<GoalNode>);
      return node;
    }),
    getGoals: vi.fn(() => Array.from(nodes.values())),
    getOpenGoals: vi.fn(() => Array.from(nodes.values()).filter(g => g.status === 'pending' || g.status === 'in_progress')),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
  } as never as KnowledgeGraph;
}

function createMockFleetBus(): FleetBus {
  return {
    emit: vi.fn(),
    filter: vi.fn(() => vi.fn()),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as never as FleetBus;
}

function createMockMailbox(): Mailbox {
  return {
    send: vi.fn(),
    query: vi.fn(),
    broadcast: vi.fn(),
  } as never as Mailbox;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskAuctioneer', () => {
  let graph: KnowledgeGraph;
  let fleet: FleetBus;
  let mailbox: Mailbox;
  let auctioneer: TaskAuctioneer;

  beforeEach(() => {
    graph = createMockGraph();
    fleet = createMockFleetBus();
    mailbox = createMockMailbox();
    auctioneer = new TaskAuctioneer({
      graph,
      fleet,
      mailbox,
      selfAgentId: 'auctioneer-test',
      bidWindowMs: 1000, // 1 second for faster tests
      maxTasksPerAgent: 3,
      minConfidence: 0.3,
    });
  });

  describe('publishTask', () => {
    it('creates a goal node in the graph', async () => {
      const taskId = await auctioneer.publishTask({
        title: 'Fix bug',
        description: 'Fix the null pointer exception',
        priority: 'high',
        tags: ['bug', 'urgent'],
      });

      expect(taskId).toBeDefined();
      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'goal',
          title: 'Fix bug',
          description: 'Fix the null pointer exception',
          priority: 'high',
          status: 'pending',
        }),
      );
    });

    it('broadcasts task via fleet bus', async () => {
      await auctioneer.publishTask({
        title: 'New task',
        description: 'Description',
      });

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task:published',
          payload: expect.objectContaining({
            title: 'New task',
          }),
        }),
      );
    });

    it('assigns directly when targetAgent is specified', async () => {
      await auctioneer.publishTask({
        title: 'Assigned task',
        description: 'This will be assigned directly',
        targetAgent: 'agent-1',
      });

      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'in_progress',
          assignee: 'agent-1',
        }),
      );
    });

    it('uses default priority when not specified', async () => {
      await auctioneer.publishTask({
        title: 'Task',
        description: 'Desc',
      });

      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'medium',
        }),
      );
    });

    it('sets parentGoal when specified', async () => {
      await auctioneer.publishTask({
        title: 'Sub-task',
        description: 'Desc',
        parentGoal: 'parent-goal-1',
      });

      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          parentGoal: 'parent-goal-1',
        }),
      );
    });
  });

  describe('bid', () => {
    it('rejects bid on non-existent task', async () => {
      const accepted = await auctioneer.bid('nonexistent', {
        agentId: 'agent-1',
        agentName: 'Alice',
        agentRole: 'bug-hunter',
      }, 'Test');

      expect(accepted).toBe(false);
    });

    it('rejects bid on already-claimed task (in_progress)', async () => {
      await auctioneer.publishTask({
        title: 'Already claimed',
        description: 'Desc',
        targetAgent: 'agent-other',
      });

      const accepted = await auctioneer.bid('goal_1', {
        agentId: 'agent-1',
        agentName: 'Alice',
        agentRole: 'bug-hunter',
      }, 'Test');

      expect(accepted).toBe(false);
    });
  });

  describe('claim', () => {
    it('awards task to agent', async () => {
      await auctioneer.publishTask({
        title: 'Task',
        description: 'Desc',
      });

      const result = await auctioneer.claim('goal_1', 'agent-1', 'Alice');

      expect(result).toBe(true);
      expect(graph.update).toHaveBeenCalledWith(
        'goal_1',
        expect.objectContaining({
          status: 'in_progress',
          assignee: 'agent-1',
        }),
      );
    });

    it('rejects claim on non-existent task', async () => {
      const result = await auctioneer.claim('nonexistent', 'agent-1', 'Alice');
      expect(result).toBe(false);
    });

    it('rejects claim on already-claimed task', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc' });
      await auctioneer.claim('goal_1', 'agent-1', 'Alice');

      const result = await auctioneer.claim('goal_1', 'agent-2', 'Bob');
      expect(result).toBe(false);
    });
  });

  describe('complete', () => {
    it('marks task as done', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc' });

      await auctioneer.complete('goal_1');

      expect(graph.update).toHaveBeenCalledWith(
        'goal_1',
        expect.objectContaining({
          status: 'done',
        }),
      );
    });

    it('handles non-existent task gracefully', async () => {
      // Should not throw
      await expect(auctioneer.complete('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('fail', () => {
    it('marks task as failed', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc' });

      await auctioneer.fail('goal_1', 'Timeout error');

      expect(graph.update).toHaveBeenCalledWith(
        'goal_1',
        expect.objectContaining({
          status: 'failed',
          result: 'Timeout error',
        }),
      );
    });
  });

  describe('getPendingTasks', () => {
    it('returns pending non-blocked tasks', async () => {
      await auctioneer.publishTask({ title: 'Task 1', description: 'D1' });
      await auctioneer.publishTask({ title: 'Task 2', description: 'D2' });

      const pending = auctioneer.getPendingTasks();

      expect(pending.length).toBeGreaterThan(0);
    });
  });

  describe('getTasksForAgent', () => {
    it('returns tasks assigned to specific agent', async () => {
      await auctioneer.publishTask({ title: 'Task', description: 'Desc', targetAgent: 'agent-1' });

      const tasks = auctioneer.getTasksForAgent('agent-1');

      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Task');
    });
  });

  describe('getBidCount', () => {
    it('returns zero for tasks with no bids', () => {
      const count = auctioneer.getBidCount('any-task');
      expect(count).toBe(0);
    });
  });

  describe('getStats', () => {
    it('reports task counts', async () => {
      await auctioneer.publishTask({ title: 'Task 1', description: 'D1' });
      await auctioneer.publishTask({ title: 'Task 2', description: 'D2', targetAgent: 'agent-1' });

      const stats = auctioneer.getStats();

      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('in_progress');
      expect(stats).toHaveProperty('done');
      expect(stats).toHaveProperty('failed');
    });
  });

  describe('default options', () => {
    it('uses sensible defaults', () => {
      const defaultAuctioneer = new TaskAuctioneer({ graph });
      expect(defaultAuctioneer).toBeDefined();
    });
  });
});
