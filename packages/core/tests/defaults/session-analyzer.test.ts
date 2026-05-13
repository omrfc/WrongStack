import { describe, it, expect } from 'vitest';
import { SessionAnalyzer } from '../../src/defaults/session-analyzer.js';

describe('SessionAnalyzer', () => {
  const analyzer = new SessionAnalyzer();

  it('analyzes empty events', () => {
    const result = analyzer.analyze([]);
    expect(result.errorCount).toBe(0);
    expect(result.toolUsageCount).toEqual({});
    expect(result.modeChanges).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.totalDuration).toBe(0);
  });

  it('counts tool_use events', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', id: '1', name: 'bash', input: {} },
      { type: 'tool_use', ts: '2024-01-01T00:00:01Z', id: '2', name: 'bash', input: {} },
      { type: 'tool_use', ts: '2024-01-01T00:00:02Z', id: '3', name: 'read', input: {} },
    ] as any[];
    const result = analyzer.analyze(events);
    expect(result.toolUsageCount['bash']).toBe(2);
    expect(result.toolUsageCount['read']).toBe(1);
  });

  it('counts error events', () => {
    const events = [
      { type: 'error', ts: '2024-01-01T00:00:00Z', phase: 'planning', message: 'boom' },
    ] as any[];
    const result = analyzer.analyze(events);
    expect(result.errorCount).toBe(1);
  });

  it('calculates totalDuration from events', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', id: '1', name: 'a', input: {} },
      { type: 'tool_use', ts: '2024-01-01T00:00:02Z', id: '2', name: 'b', input: {} },
    ] as any[];
    const result = analyzer.analyze(events);
    expect(result.totalDuration).toBe(2000);
  });

  it('returns 0 duration for single event', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', id: '1', name: 'a', input: {} },
    ] as any[];
    const result = analyzer.analyze(events);
    expect(result.totalDuration).toBe(0);
  });

  it('query filters by eventTypes', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', name: 'a', input: {} } as any,
      { type: 'error', ts: '2024-01-01T00:00:01Z', message: '' } as any,
      { type: 'user_input', ts: '2024-01-01T00:00:02Z', content: 'hello' } as any,
    ];
    const result = analyzer.query(events, { eventTypes: ['tool_use', 'error'] });
    expect(result).toHaveLength(2);
  });

  it('query filters by toolNames', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', id: '1', name: 'bash', input: {} } as any,
      { type: 'tool_use', ts: '2024-01-01T00:00:01Z', id: '2', name: 'read', input: {} } as any,
    ];
    const result = analyzer.query(events, { toolNames: ['bash'] });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('bash');
  });

  it('query filters by timeRange', () => {
    const events = [
      { type: 'user_input', ts: '2024-01-01T00:00:00Z', content: 'a' } as any,
      { type: 'user_input', ts: '2024-01-01T00:00:05Z', content: 'b' } as any,
      { type: 'user_input', ts: '2024-01-01T00:00:10Z', content: 'c' } as any,
    ];
    const result = analyzer.query(events, {
      timeRange: { start: '2024-01-01T00:00:03Z', end: '2024-01-01T00:00:07Z' },
    });
    expect(result).toHaveLength(1);
  });

  it('query returns all when no filter', () => {
    const events = [
      { type: 'user_input', ts: '2024-01-01T00:00:00Z', content: 'a' } as any,
    ];
    const result = analyzer.query(events, {});
    expect(result).toHaveLength(1);
  });
});
