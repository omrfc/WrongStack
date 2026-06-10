/**
 * AgentStatusTracker unit tests — verify that EventBus events correctly
 * translate to SessionRegistry.updateAgents() calls with the right state.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentStatusTracker } from '../src/agent-status-tracker.js';
import type { AgentEntry } from '../src/session-registry.js';
import type { SessionRegistry } from '../src/session-registry.js';

// ── Mocks ──────────────────────────────────────────────────────────────

/** Minimal mock EventBus — only the surface AgentStatusTracker touches. */
function mockEventBus() {
  const listeners = new Map<string, Array<(event: string, payload: unknown) => void>>();
  return {
    onPattern: vi.fn(
      (pattern: string, fn: (event: string, payload: unknown) => void) => {
        const list = listeners.get(pattern) ?? [];
        list.push(fn);
        listeners.set(pattern, list);
        return () => {
          const idx = list.indexOf(fn);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
    ),
    /** Fire an event to all matching pattern listeners. */
    emit: (event: string, payload: unknown) => {
      for (const [pattern, fns] of listeners) {
        if (event.startsWith(pattern.replace('*', ''))) {
          for (const fn of fns) fn(event, payload);
        }
      }
    },
  };
}

/** Spy on SessionRegistry.updateAgents */
function mockRegistry() {
  return {
    updateAgents: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionRegistry;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('AgentStatusTracker', () => {
  let events: ReturnType<typeof mockEventBus>;
  let registry: ReturnType<typeof mockRegistry>;
  let tracker: AgentStatusTracker;

  beforeEach(() => {
    events = mockEventBus();
    registry = mockRegistry();
    tracker = new AgentStatusTracker({
      events: events as unknown as import('@wrongstack/core').EventBus,
      registry: registry as unknown as SessionRegistry,
    });
  });

  // ── Leader events ──────────────────────────────────────────────────

  it('sets leader to running on agent.run.started', () => {
    tracker.start();
    events.emit('agent.run.started', {});

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('running');
    expect(leader?.iterations).toBe(1);
  });

  it('sets leader to idle on agent.run.completed', () => {
    tracker.start();
    events.emit('agent.run.started', {});
    events.emit('agent.run.completed', {});

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('idle');
  });

  it('sets leader to error on agent.run.error', () => {
    tracker.start();
    events.emit('agent.run.error', { err: new Error('boom') });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('error');
  });

  it('tracks current tool on tool.started', () => {
    tracker.start();
    events.emit('tool.started', { name: 'bash', id: 'tu-1' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.currentTool).toBe('bash');
    expect(leader?.toolCalls).toBe(1);
  });

  it('clears current tool on tool.executed', () => {
    tracker.start();
    events.emit('tool.started', { name: 'read', id: 'tu-2' });
    events.emit('tool.executed', { name: 'read', id: 'tu-2' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.currentTool).toBeUndefined();
  });

  it('sets leader to waiting_user on brain.ask_human', () => {
    tracker.start();
    events.emit('brain.ask_human', {});

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('waiting_user');
  });

  it('sets leader to streaming on llm.stream_started', () => {
    tracker.start();
    events.emit('llm.stream_started', {});

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('streaming');
  });

  // ── Fleet events ───────────────────────────────────────────────────

  it('adds subagent on fleet.subagent.spawned', () => {
    tracker.start();
    events.emit('fleet.subagent.spawned', { subagentId: 'sa-1', name: 'bug-hunter' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-1');
    expect(sub).toBeDefined();
    expect(sub?.name).toBe('bug-hunter');
    expect(sub?.status).toBe('idle');
    expect(sub?.iterations).toBe(0);
  });

  it('updates subagent to running on task_started', () => {
    tracker.start();
    events.emit('fleet.subagent.spawned', { subagentId: 'sa-2', name: 'refactor-planner' });
    events.emit('fleet.subagent.task_started', { subagentId: 'sa-2' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-2');
    expect(sub?.status).toBe('running');
    expect(sub?.iterations).toBe(1);
  });

  it('sets subagent to idle on task_completed', () => {
    tracker.start();
    events.emit('fleet.subagent.spawned', { subagentId: 'sa-3', name: 'critic' });
    events.emit('fleet.subagent.task_started', { subagentId: 'sa-3' });
    events.emit('fleet.subagent.task_completed', { subagentId: 'sa-3' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-3');
    expect(sub?.status).toBe('idle');
  });

  it('sets subagent to error on fleet.subagent.error', () => {
    tracker.start();
    events.emit('fleet.subagent.spawned', { subagentId: 'sa-4', name: 'worker' });
    events.emit('fleet.subagent.error', { subagentId: 'sa-4' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-4');
    expect(sub?.status).toBe('error');
  });

  it('removes subagent on fleet.subagent.stopped', () => {
    tracker.start();
    events.emit('fleet.subagent.spawned', { subagentId: 'sa-5', name: 'temp' });
    events.emit('fleet.subagent.stopped', { subagentId: 'sa-5' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-5');
    expect(sub).toBeUndefined();
  });

  // ── Fleet: multiple agents ─────────────────────────────────────────

  it('tracks leader + multiple subagents simultaneously', () => {
    tracker.start();
    events.emit('agent.run.started', {});
    events.emit('tool.started', { name: 'bash', id: 't1' });
    events.emit('fleet.subagent.spawned', { subagentId: 's1', name: 'bug-hunter' });
    events.emit('fleet.subagent.spawned', { subagentId: 's2', name: 'refactor' });
    events.emit('fleet.subagent.task_started', { subagentId: 's1' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    expect(call).toHaveLength(3); // leader + 2 subagents

    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('running');
    expect(leader?.currentTool).toBe('bash');

    const s1 = call?.find((a: AgentEntry) => a.id === 's1');
    expect(s1?.status).toBe('running');
    expect(s1?.iterations).toBe(1);

    const s2 = call?.find((a: AgentEntry) => a.id === 's2');
    expect(s2?.status).toBe('idle');
    expect(s2?.iterations).toBe(0);
  });

  // ── Stop / cleanup ─────────────────────────────────────────────────

  it('stop() unsubscribes all listeners', () => {
    tracker.start();
    tracker.stop();

    // After stop, events should NOT trigger updateAgents
    const beforeCount = registry.updateAgents.mock.calls.length;
    events.emit('agent.run.started', {});
    expect(registry.updateAgents.mock.calls.length).toBe(beforeCount);
  });

  // ── Custom leader name ─────────────────────────────────────────────

  it('uses custom leader name when provided', () => {
    const customTracker = new AgentStatusTracker({
      events: events as unknown as import('@wrongstack/core').EventBus,
      registry: registry as unknown as SessionRegistry,
      leaderName: 'commander',
    });
    customTracker.start();
    events.emit('agent.run.started', {});

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.name).toBe('commander');
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it('ignores fleet events for unknown subagents', () => {
    tracker.start();
    const beforeCount = registry.updateAgents.mock.calls.length;
    events.emit('fleet.subagent.task_started', { subagentId: 'ghost' });

    // Tracker only flushes when it finds a matching entry — ghost should not trigger update
    expect(registry.updateAgents.mock.calls.length).toBe(beforeCount);
  });

  it('handles multiple tool.started calls (toolCalls increments)', () => {
    tracker.start();
    events.emit('tool.started', { name: 'read', id: 't1' });
    events.emit('tool.started', { name: 'write', id: 't2' });
    events.emit('tool.started', { name: 'bash', id: 't3' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.toolCalls).toBe(3);
  });

  it('does not register updateAgents failure as a crash', () => {
    const failingRegistry = {
      updateAgents: vi.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as SessionRegistry;
    const t = new AgentStatusTracker({
      events: events as unknown as import('@wrongstack/core').EventBus,
      registry: failingRegistry,
    });
    t.start();

    // Should not throw
    expect(() => events.emit('agent.run.started', {})).not.toThrow();
  });
});
