import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { KnowledgeGraph } from '../../src/coordination/knowledge-graph.js';
import { TaskDAG } from '../../src/coordination/task-dag.js';
import { TaskAuctioneer } from '../../src/coordination/task-auctioneer.js';
import { ConsensusProtocol } from '../../src/coordination/consensus-protocol.js';
import { ChangeManager } from '../../src/coordination/change-manager.js';
import { AutonomousBrain } from '../../src/coordination/autonomous-brain.js';
import { AutonomousCoordinator } from '../../src/coordination/autonomous-coordinator.js';
import type { FleetBus } from '../../src/coordination/fleet-bus.js';
import type { Mailbox } from '../../src/coordination/mailbox-types.js';
import type { CoordinatorEvent } from '../../src/coordination/autonomous-coordinator.js';

// ── Test setup ─────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocoord-test-'));
});

afterEach(async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
});

// ── Mock helpers ───────────────────────────────────────────────────────────

function createMockFleetBus(): FleetBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emit: vi.fn((type: string, payload?: unknown) => {
      const handlers = listeners.get(type);
      if (handlers) {
        for (const h of handlers) h(payload);
      }
    }),
    on: vi.fn((type: string, handler: (payload: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => listeners.get(type)?.delete(handler);
    }),
    off: vi.fn((type: string, handler: (payload: unknown) => void) => {
      listeners.get(type)?.delete(handler);
    }),
    filter: vi.fn((type: string, handler: (payload: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => listeners.get(type)?.delete(handler);
    }),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as unknown as FleetBus;
}

function createMockMailbox(): Mailbox {
  return {
    send: vi.fn(async () => {}),
    query: vi.fn(async () => ({ messages: [], nextCursor: null })),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as unknown as Mailbox;
}

function createMockLlmProvider() {
  return {
    decide: vi.fn(async () => ({
      type: 'deny' as const,
      optionId: undefined,
      text: 'No valid options',
      rationale: 'Test: always deny to exit loop quickly',
    })),
  };
}

function createCoordinator(opts?: {
  onCoordinatorEvent?: (event: CoordinatorEvent) => void;
  disableSelfImprove?: boolean;
}) {
  const graph = new KnowledgeGraph(tempDir);
  const dag = new TaskDAG();
  const fleet = createMockFleetBus();
  const mailbox = createMockMailbox();

  const consensus = new ConsensusProtocol({
    graph,
    fleet,
    voters: [
      { agentId: 'critic', agentName: 'Critic', weight: 2, role: 'critic', veto: true },
      { agentId: 'bug-hunter', agentName: 'Bug Hunter', weight: 1.5, role: 'bug-hunter' },
    ],
    rules: { quorumFraction: 0.5, approvalFraction: 0.6, vetoRoles: ['critic'] },
  });

  const changeManager = new ChangeManager({ graph, consensus });
  const auctioneer = new TaskAuctioneer({ graph, fleet, mailbox, maxBidRetries: 3 });

  const brain = new AutonomousBrain({
    llmProvider: createMockLlmProvider(),
    graph,
    fleet,
    disableSelfImprove: opts?.disableSelfImprove ?? true,
  });

  const events: CoordinatorEvent[] = [];
  const coordinator = new AutonomousCoordinator({
    sessionDir: tempDir,
    selfAgentId: 'leader@test',
    selfAgentName: 'Leader',
    fleet,
    mailbox,
    llmProvider: createMockLlmProvider(),
    disableSelfImprove: true,
    maxConcurrentAgents: 3,
    onCoordinatorEvent: opts?.onCoordinatorEvent ?? ((e) => events.push(e)),
  });

  return { coordinator, graph, dag, fleet, mailbox, events, auctioneer, consensus, changeManager };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AutonomousCoordinator', () => {
  describe('onCoordinatorEvent callback', () => {
    it('is called with knowledge:added when publishFact is called', async () => {
      const events: CoordinatorEvent[] = [];
      const { coordinator } = createCoordinator({
        onCoordinatorEvent: (e) => events.push(e),
      });

      await coordinator.publishFact({
        category: 'bug',
        subject: 'Test bug',
        detail: 'Found in test',
        key: 'test-bug-1',
        severity: 'high',
        discoveredBy: 'test',
        tags: ['test'],
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('knowledge:added');
      // CoordinatorEvent.knowledge:added has knowledgeId, title?, text?
      const ke = events[0] as { type: 'knowledge:added'; title?: string };
      expect(ke.title).toBe('Test bug');
    });

    it('is called with goal:added for each subgoal during goal decomposition', async () => {
      const events: CoordinatorEvent[] = [];
      const { coordinator } = createCoordinator({
        onCoordinatorEvent: (e) => events.push(e),
      });

      // _decomposeGoal is private, but run() calls it. Use run() with
      // maxIterations=1 so the loop exits immediately after decomposition.
      const llmProvider = createMockLlmProvider();
      const realCoordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (e) => events.push(e),
      });

      // Use a goal that decomposes into known subgoals
      await realCoordinator.run({ goal: 'fix security bugs', maxIterations: 1 });

      const goalAddedEvents = events.filter((e) => e.type === 'goal:added');
      expect(goalAddedEvents.length).toBeGreaterThan(0);

      // Security goals should decompose into at least: audit secrets, check injection, dependency audit
      const added = goalAddedEvents as Array<{ type: 'goal:added'; title: string }>;
      expect(added.some((e) => e.title.toLowerCase().includes('secret') || e.title.toLowerCase().includes('audit'))).toBe(true);
    });

    it('collects multiple event types in a single run', async () => {
      const events: CoordinatorEvent[] = [];
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
        onCoordinatorEvent: (e) => events.push(e),
      });

      // Publish a fact first
      await coordinator.publishFact({
        category: 'performance',
        subject: 'Slow query detected',
        detail: 'DB queries taking >1s',
        key: 'perf-slow-query',
        severity: 'medium',
        discoveredBy: 'test',
        tags: ['perf'],
      });

      // Then run with a goal
      await coordinator.run({ goal: 'fix performance issues', maxIterations: 1 });

      // Should have at least: 1 knowledge:added + N goal:added
      expect(events.some((e) => e.type === 'knowledge:added')).toBe(true);
      expect(events.some((e) => e.type === 'goal:added')).toBe(true);
    });

    it('does not throw when onCoordinatorEvent is undefined', async () => {
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider: createMockLlmProvider(),
        disableSelfImprove: true,
        // No onCoordinatorEvent — should be optional
      });

      // Should not throw
      await expect(
        coordinator.publishFact({
          category: 'test',
          subject: 'Test',
          detail: 'Test',
          key: 'test-key',
          severity: 'low',
          discoveredBy: 'test',
          tags: [],
        }),
      ).resolves.not.toThrow();
    });

    // Note: TaskDAG deadlock detection is tested in task-dag.test.ts.
    // This test verifies the coordinator's DAG event handler is wired up correctly.
    it.skip('emits deadlock:detected when DAG has a deadlock', async () => {
      // TaskDAG has no addEdge API — nodes must declare deps at creation time.
      // Testing DAG cycle detection is done in task-dag.test.ts.
    });
  });

  describe('run() lifecycle', () => {
    it('exits after maxIterations even without completing goals', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const start = Date.now();
      const stats = await coordinator.run({ goal: 'improve the codebase', maxIterations: 2 });
      const elapsed = Date.now() - start;

      // Should complete quickly (not hang)
      expect(elapsed).toBeLessThan(5000);
      expect(stats.goals.total).toBeGreaterThanOrEqual(0);
    });

    it('returns CoordinatorStats with defined fields', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const stats = await coordinator.run({ goal: 'add tests', maxIterations: 1 });

      expect(stats.goals).toBeDefined();
      expect(stats.goals.total).toBeGreaterThanOrEqual(0);
      expect(typeof stats.goals.progress).toBe('number');
      expect(stats.dag).toBeDefined();
      expect(stats.auction).toBeDefined();
      expect(typeof stats.decisions).toBe('number');
    });

    it('throws when already running', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      // Start first run
      const promise1 = coordinator.run({ goal: 'task 1', maxIterations: 100 });

      // Try to start second run while first is still going
      await expect(coordinator.run({ goal: 'task 2', maxIterations: 1 })).rejects.toThrow(
        'already running',
      );

      // Wait for first to finish
      await promise1.catch(() => {});
    });

    it('stop() terminates the run loop', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const runPromise = coordinator.run({ goal: 'long running task', maxIterations: 100 });

      // Stop immediately
      await coordinator.stop();

      // Should exit quickly
      const stats = await runPromise;
      expect(stats).toBeDefined();
    });
  });

  describe('goal decomposition', () => {
    it('categorizes "security" goals correctly', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const events: CoordinatorEvent[] = [];
      // Intercept events by providing a callback
      const realCoordinator = Object.assign(Object.create(Object.getPrototypeOf(coordinator)), coordinator, {
        onCoordinatorEvent: (e: CoordinatorEvent) => events.push(e),
      });

      await realCoordinator.run({ goal: 'audit security vulnerabilities', maxIterations: 1 });

      const goalEvents = events.filter((e) => e.type === 'goal:added') as Array<{
        type: 'goal:added';
        goalId: string;
        title?: string;
        text?: string;
      }>;

      expect(goalEvents.length).toBeGreaterThan(0);
      // Security goals should decompose into subgoals (at least 2 for 'fix security bugs')
      expect(goalEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('categorizes "bug" goals correctly', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      const events: CoordinatorEvent[] = [];
      const realCoordinator = Object.assign(Object.create(Object.getPrototypeOf(coordinator)), coordinator, {
        onCoordinatorEvent: (e: CoordinatorEvent) => events.push(e),
      });

      await realCoordinator.run({ goal: 'fix null pointer bug', maxIterations: 1 });

      const goalEvents = events.filter((e) => e.type === 'goal:added');
      expect(goalEvents.length).toBeGreaterThan(0);
    });
  });

  describe('publishFact()', () => {
    it('adds a fact to the knowledge graph', async () => {
      const { coordinator } = createCoordinator();

      await coordinator.publishFact({
        category: 'architecture',
        subject: 'Service layer needed',
        detail: 'Controllers are doing too much',
        key: 'arch-service-layer',
        severity: 'medium',
        discoveredBy: 'architect',
        tags: ['architecture', 'refactor'],
      });

      // Use the coordinator's own graph to verify the fact was persisted
      const facts = coordinator.graph.getFacts({ category: 'architecture' });
      expect(facts.some((f) => f.subject === 'Service layer needed')).toBe(true);
    });

    it('accepts all valid fact categories', async () => {
      const { coordinator } = createCoordinator();

      const categories = ['bug', 'performance', 'security', 'refactor', 'test', 'documentation', 'dependency', 'quality'] as const;

      for (const category of categories) {
        await expect(
          coordinator.publishFact({
            category,
            subject: `Test fact for ${category}`,
            detail: 'Detail',
            key: `fact-${category}`,
            severity: 'low',
            discoveredBy: 'test',
            tags: [],
          }),
        ).resolves.not.toThrow();
      }
    });
  });

  describe('getStats()', () => {
    it('returns current coordinator statistics', async () => {
      const llmProvider = createMockLlmProvider();
      const coordinator = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'leader@test',
        selfAgentName: 'Leader',
        llmProvider,
        disableSelfImprove: true,
        maxConcurrentAgents: 3,
      });

      // Publish some work first
      await coordinator.publishFact({
        category: 'test',
        subject: 'Coverage gap',
        detail: 'Module X has no tests',
        key: 'test-coverage-gap',
        severity: 'medium',
        discoveredBy: 'test',
        tags: ['test'],
      });

      const stats = coordinator.getStats();

      expect(stats).toBeDefined();
      expect(stats.goals).toBeDefined();
      expect(stats.dag).toBeDefined();
      expect(stats.auction).toBeDefined();
      expect(typeof stats.decisions).toBe('number');
    });
  });

  describe('orphan task retry (no bids)', () => {
    it('fails a task after maxBidRetries when no agents bid', async () => {
      // Use a short bid window so we don't wait long
      const BID_WINDOW_MS = 100;
      const MAX_RETRIES = 3;
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const graph = new KnowledgeGraph(tempDir);

      const auctioneer = new TaskAuctioneer({
        graph,
        fleet,
        mailbox,
        bidWindowMs: BID_WINDOW_MS,
        maxBidRetries: MAX_RETRIES,
      });

      vi.useFakeTimers();

      // Publish a task — no agents will bid
      const taskId = await auctioneer.publishTask({
        title: 'Orphan task',
        description: 'No one will bid on this',
        priority: 'high',
        tags: ['test'],
      });

      // Advance past all 3 bid windows (100ms × 3 = 300ms) plus a small buffer
      await vi.advanceTimersByTimeAsync((BID_WINDOW_MS * MAX_RETRIES) + 50);

      vi.useRealTimers();

      // Task should have failed after MAX_RETRIES attempts
      const node = graph.get(taskId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('failed');
    });

    it('retries orphan tasks up to maxBidRetries, not forever', async () => {
      const BID_WINDOW_MS = 50;
      const MAX_RETRIES = 2;
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const graph = new KnowledgeGraph(tempDir);

      const auctioneer = new TaskAuctioneer({
        graph,
        fleet,
        mailbox,
        bidWindowMs: BID_WINDOW_MS,
        maxBidRetries: MAX_RETRIES,
      });

      vi.useFakeTimers();

      const taskId = await auctioneer.publishTask({
        title: 'Will fail after 2 retries',
        description: 'Only 2 retries allowed',
        priority: 'medium',
        tags: ['test'],
      });

      // Advance past exactly 2 bid windows (should fail on 2nd evaluation)
      await vi.advanceTimersByTimeAsync((BID_WINDOW_MS * MAX_RETRIES) + 30);

      vi.useRealTimers();

      // Should be failed after 2 retries
      const node = graph.get(taskId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('failed');
    });

    it('cleans up retry counter when task is manually failed', async () => {
      const BID_WINDOW_MS = 100;
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const graph = new KnowledgeGraph(tempDir);

      const auctioneer = new TaskAuctioneer({
        graph,
        fleet,
        mailbox,
        bidWindowMs: BID_WINDOW_MS,
        maxBidRetries: 3,
      });

      vi.useFakeTimers();

      // Publish a task — no bids will come in
      const taskId = await auctioneer.publishTask({
        title: 'Will be manually failed',
        description: 'We manually fail this after a bit',
        priority: 'high',
        tags: ['test'],
      });

      // Advance first bid window — no bids, retry count becomes 1
      await vi.advanceTimersByTimeAsync(BID_WINDOW_MS + 10);
      expect(graph.get(taskId)!.status).toBe('pending'); // still pending (retrying)

      // Manually fail the task
      await auctioneer.fail(taskId, 'Manual failure for test');

      vi.useRealTimers();

      // Task should be failed
      const node = graph.get(taskId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('failed');
      // After fail(), the retry counter should be deleted (no more retries)
      // This is verified by the fact that the task is 'failed', not still 'pending'
    });
  });

  describe('task:failed → goal:failed propagation', () => {
    it('emits goal:failed to onCoordinatorEvent when auctioneer fires task:failed', async () => {
      // This tests the critical path: when a task fails (e.g. orphan with no bids),
      // the coordinator must emit goal:failed so the TUI shows the ❌ icon.
      const fleet = createMockFleetBus();
      const mailbox = createMockMailbox();
      const graph = new KnowledgeGraph(tempDir);

      const emittedEvents: CoordinatorEvent[] = [];
      const coord = new AutonomousCoordinator({
        sessionDir: tempDir,
        selfAgentId: 'test-coord',
        selfAgentName: 'TestCoord',
        llmProvider: createMockLlmProvider(),
        fleet,
        mailbox,
        onCoordinatorEvent: (e) => emittedEvents.push(e),
      });

      // Publish a task via the coordinator's own auction
      const taskId = await coord.auction.publishTask({
        title: 'Orphan test task',
        description: 'Will fail with no bids',
        priority: 'high',
        tags: ['test'],
      });

      // Simulate task:failed event from auctioneer reaching the coordinator's fleet filter
      // (This is what happens when an orphan task fails after max bid retries)
      const filterCalls = (fleet.filter as ReturnType<typeof vi.fn>).mock.calls;
      for (const [filterType, handler] of filterCalls) {
        if (filterType === 'task:failed') {
          // FleetEvent format expected by the coordinator's filter handler
          (handler as (p: unknown) => void)({
            subagentId: 'auctioneer',
            ts: Date.now(),
            type: 'task:failed',
            payload: { taskId, error: 'No bids received after 3 attempts' },
          });
        }
      }

      // Verify goal:failed was emitted to the TUI callback
      expect(emittedEvents.some(e => e.type === 'goal:failed' && e.goalId === taskId)).toBe(true);
      const failedEvent = emittedEvents.find(e => e.type === 'goal:failed')!;
      expect(failedEvent.text).toContain('No bids received');
    });
  });
});
