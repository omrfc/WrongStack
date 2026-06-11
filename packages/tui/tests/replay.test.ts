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

  it('does not duplicate a tool call recorded as tool_call_start → tool_call_end → tool_result', () => {
    // Standard audit level logs all three events for one call. The richer
    // tool_call_end renders the entry; the trailing tool_result must be
    // swallowed instead of rendering the same call again named by raw id.
    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:00Z', content: 'read a file' },
      { type: 'tool_call_start', ts: '2026-01-01T00:00:01Z', name: 'read', id: 'tu-1', input: { path: 'a.ts' } },
      { type: 'tool_call_end', ts: '2026-01-01T00:00:02Z', name: 'read', id: 'tu-1', durationMs: 42, outputSize: 10, ok: true },
      { type: 'tool_result', ts: '2026-01-01T00:00:03Z', id: 'tu-1', content: 'contents', isError: false },
    ];
    const entries = replaySessionEvents(events, 1);
    const tools = entries.filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ kind: 'tool', name: 'read', durationMs: 42, ok: true });
  });

  it('still renders tool_result alone at minimal audit level (no tool_call events)', () => {
    const events: SessionEvent[] = [
      { type: 'tool_result', ts: '2026-01-01T00:00:00Z', id: 'tu-9', content: 'ok', isError: false },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', ok: true });
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
