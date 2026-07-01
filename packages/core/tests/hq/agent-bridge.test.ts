import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { startAgentMonitorEventBridge } from '../../src/hq/agent-bridge.js';

const emit = (events: EventBus, type: string, payload: object) =>
  (events as unknown as { emit: (t: string, p: object) => void }).emit(type, payload);

const baseMsg = { subagentId: 's1', agentName: 'Alpha', content: 'hi', kind: 'text', iteration: 1, ts: '2026-01-01T00:00:00Z' };
const baseStatus = { subagentId: 's1', agentName: 'Alpha', status: 'running', ts: '2026-01-01T00:00:00Z' };

describe('startAgentMonitorEventBridge', () => {
  it('forwards timeline messages with optional tool/cost fields', () => {
    const events = new EventBus();
    const publish = vi.fn();
    const dispose = startAgentMonitorEventBridge({ events, clientId: 'c1', projectId: 'p1', publish });
    emit(events, 'agent.timeline.message', { ...baseMsg, toolName: 'bash', costUsd: 0.01 });
    expect(publish).toHaveBeenCalledTimes(1);
    const env = publish.mock.calls[0]![0];
    expect(env.type).toBe('agent.message');
    expect(env.clientId).toBe('c1');
    expect(env.projectId).toBe('p1');
    expect(env.payload.toolName).toBe('bash');
    expect(env.payload.costUsd).toBe(0.01);
    dispose();
  });

  it('forwards timeline messages without optional fields', () => {
    const events = new EventBus();
    const publish = vi.fn();
    startAgentMonitorEventBridge({ events, clientId: 'c1', projectId: 'p1', publish });
    emit(events, 'agent.timeline.message', baseMsg);
    const env = publish.mock.calls[0]![0];
    expect(env.payload.toolName).toBeUndefined();
    expect(env.payload.costUsd).toBeUndefined();
  });

  it('forwards status changes with optional summary/task', () => {
    const events = new EventBus();
    const publish = vi.fn();
    startAgentMonitorEventBridge({ events, clientId: 'c1', projectId: 'p1', publish });
    emit(events, 'agent.status_changed', { ...baseStatus, summary: 'done', task: 'ship it' });
    const env = publish.mock.calls[0]![0];
    expect(env.type).toBe('agent.status');
    expect(env.payload.summary).toBe('done');
    expect(env.payload.task).toBe('ship it');
  });

  it('forwards status changes without optional fields', () => {
    const events = new EventBus();
    const publish = vi.fn();
    startAgentMonitorEventBridge({ events, clientId: 'c1', projectId: 'p1', publish });
    emit(events, 'agent.status_changed', baseStatus);
    const env = publish.mock.calls[0]![0];
    expect(env.payload.summary).toBeUndefined();
    expect(env.payload.task).toBeUndefined();
  });

  it('drops events silently when no publish callback is wired', () => {
    const events = new EventBus();
    const dispose = startAgentMonitorEventBridge({ events, clientId: 'c1', projectId: 'p1' });
    emit(events, 'agent.timeline.message', baseMsg);
    emit(events, 'agent.status_changed', baseStatus);
    dispose();
  });

  it('disposer unsubscribes both listeners', () => {
    const events = new EventBus();
    const publish = vi.fn();
    const dispose = startAgentMonitorEventBridge({ events, clientId: 'c1', projectId: 'p1', publish });
    dispose();
    emit(events, 'agent.timeline.message', baseMsg);
    emit(events, 'agent.status_changed', baseStatus);
    expect(publish).not.toHaveBeenCalled();
  });
});
