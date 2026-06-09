import { describe, expect, it } from 'vitest';
import { replaySessionEvents } from '../src/components/history/replay.js';
import type { SessionEvent } from '@wrongstack/core';

describe('replaySessionEvents', () => {
  it('converts user_input events to user entries', () => {
    const events: SessionEvent[] = [
      {
        type: 'user_input',
        ts: '2026-01-01T00:00:00Z',
        content: 'hello world',
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 1, kind: 'user', text: 'hello world' });
  });

  it('converts user_input with ContentBlock[] to text', () => {
    const events: SessionEvent[] = [
      {
        type: 'user_input',
        ts: '2026-01-01T00:00:00Z',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_result', tool_use_id: '1', content: 'ignored' },
          { type: 'text', text: ' world' },
        ],
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'hello world' });
  });

  it('converts llm_response events to assistant entries', () => {
    const events: SessionEvent[] = [
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:00Z',
        content: [{ type: 'text', text: 'I am an assistant reply.' }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 5 },
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 1, kind: 'assistant', text: 'I am an assistant reply.' });
  });

  it('pairs tool_use with tool_result into a single tool entry', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', ts: '2026-01-01T00:00:00Z', name: 'read', id: 'tu-1', input: { path: 'foo.ts' } },
      { type: 'tool_result', ts: '2026-01-01T00:00:01Z', id: 'tu-1', content: 'file content here', isError: false },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      name: 'read',
      ok: true,
      input: { path: 'foo.ts' },
      output: 'file content here',
    });
  });

  it('marks tool errors when isError is true', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', ts: '2026-01-01T00:00:00Z', name: 'bash', id: 'tu-2', input: {} },
      { type: 'tool_result', ts: '2026-01-01T00:00:01Z', id: 'tu-2', content: 'command failed', isError: true },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries[0]).toMatchObject({ kind: 'tool', ok: false });
  });

  it('converts compaction events to info entries', () => {
    const events: SessionEvent[] = [
      { type: 'compaction', ts: '2026-01-01T00:00:00Z', before: 50000, after: 30000, level: 'soft' },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'info' });
    expect((entries[0] as { text: string }).text).toContain('compacted');
  });

  it('converts error events to error entries', () => {
    const events: SessionEvent[] = [
      { type: 'error', ts: '2026-01-01T00:00:00Z', message: 'something broke', phase: 'agent' },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'error' });
    expect((entries[0] as { text: string }).text).toContain('something broke');
  });

  it('converts agent_spawned to subagent entries', () => {
    const events: SessionEvent[] = [
      { type: 'agent_spawned', ts: '2026-01-01T00:00:00Z', agentId: 'agent_123456789', role: 'bug-hunter' },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'subagent',
      agentLabel: 'agent_12',
      icon: '⚡',
      text: 'spawned as bug-hunter',
    });
  });

  it('skips internal events (session_start, in_flight, etc.)', () => {
    const events: SessionEvent[] = [
      { type: 'session_start', ts: '2026-01-01T00:00:00Z', id: 's1', model: 'gpt4', provider: 'openai' },
      { type: 'user_input', ts: '2026-01-01T00:00:01Z', content: 'test' },
      { type: 'session_end', ts: '2026-01-01T00:00:02Z', usage: { input: 0, output: 0 } },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:03Z', context: 'doing stuff' },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:04Z', reason: 'clean' },
    ];
    const entries = replaySessionEvents(events, 1);
    // Only user_input should produce a visible entry
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'test' });
  });

  it('flushes orphaned tool_use events (no matching tool_result)', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', ts: '2026-01-01T00:00:00Z', name: 'read', id: 'orphaned', input: {} },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', name: 'read', ok: false });
  });

  it('preserves event order for mixed event types', () => {
    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:00Z', content: 'question 1' },
      { type: 'llm_response', ts: '2026-01-01T00:00:01Z', content: [{ type: 'text', text: 'answer 1' }], stopReason: 'end_turn', usage: { input: 0, output: 0 } },
      { type: 'error', ts: '2026-01-01T00:00:02Z', message: 'something failed', phase: 'agent' },
      { type: 'user_input', ts: '2026-01-01T00:00:03Z', content: 'question 2' },
      { type: 'compaction', ts: '2026-01-01T00:00:04Z', before: 10000, after: 5000 },
      { type: 'llm_response', ts: '2026-01-01T00:00:05Z', content: [{ type: 'text', text: 'answer 2' }], stopReason: 'end_turn', usage: { input: 0, output: 0 } },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'error', 'user', 'info', 'assistant']);
  });

  it('assigns incrementing sequential ids', () => {
    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:00Z', content: 'a' },
      { type: 'user_input', ts: '2026-01-01T00:00:01Z', content: 'b' },
      { type: 'user_input', ts: '2026-01-01T00:00:02Z', content: 'c' },
    ];
    const entries = replaySessionEvents(events, 10);
    expect(entries.map((e) => e.id)).toEqual([10, 11, 12]);
  });
});
