import type { StreamEvent } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { aggregateStream } from '../src/aggregate.js';
import { parseSSE } from '../src/sse.js';

function bodyFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

describe('parseSSE', () => {
  it('parses single event with named type and data', async () => {
    const body = bodyFrom(['event: message_start\ndata: {"type":"message_start"}\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'message_start', data: '{"type":"message_start"}' }]);
  });

  it('accumulates multi-line data fields', async () => {
    const body = bodyFrom(['data: line1\ndata: line2\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('ignores comments and unknown fields', async () => {
    const body = bodyFrom([':keepalive\nretry: 1000\nid: 7\ndata: x\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('handles chunks that split mid-line', async () => {
    const body = bodyFrom(['event: a\ndata: hel', 'lo\n\nev', 'ent: b\ndata: world\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([
      { event: 'a', data: 'hello' },
      { event: 'b', data: 'world' },
    ]);
  });

  it('handles CRLF line endings', async () => {
    const body = bodyFrom(['event: x\r\ndata: y\r\n\r\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'x', data: 'y' }]);
  });
});

async function* arr<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

describe('aggregateStream', () => {
  it('builds a text-only Response from text_delta sequence', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 5, output: 2 } },
    ];
    const res = await aggregateStream(arr(events));
    expect(res.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ input: 5, output: 2 });
    expect(res.model).toBe('m');
  });

  it('accumulates tool_use input from partial JSON deltas', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'tool_use_start', id: 'u1', name: 'echo' },
      { type: 'tool_use_input_delta', id: 'u1', partial: '{"text":' },
      { type: 'tool_use_input_delta', id: 'u1', partial: '"hi"}' },
      { type: 'tool_use_stop', id: 'u1', input: undefined as unknown as unknown },
      { type: 'message_stop', stopReason: 'tool_use', usage: { input: 5, output: 2 } },
    ];
    const res = await aggregateStream(arr(events));
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'hi' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
  });

  it('preserves text + tool_use block order', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'thinking' },
      { type: 'tool_use_start', id: 't1', name: 'fn' },
      { type: 'tool_use_stop', id: 't1', input: { x: 1 } },
      { type: 'text_delta', text: 'done' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 5, output: 2 } },
    ];
    const res = await aggregateStream(arr(events));
    expect(res.content).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 't1', name: 'fn', input: { x: 1 } },
      { type: 'text', text: 'done' },
    ]);
  });

  it('calls onEvent for every event in order', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'a' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } },
    ];
    const seen: string[] = [];
    await aggregateStream(arr(events), (e) => seen.push(e.type));
    expect(seen).toEqual(['message_start', 'text_delta', 'message_stop']);
  });
});
