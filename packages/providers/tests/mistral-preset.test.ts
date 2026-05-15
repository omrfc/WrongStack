import type { StreamEvent } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { mistralWireFormat } from '../src/presets/mistral.js';
import { WireFormatProvider } from '../src/wire-format.js';

/**
 * Smoke test for the declarative Mistral preset. The point isn't to be
 * exhaustive about Mistral's wire format — that belongs in integration tests
 * against the real API. The point is to verify that a ~50-line declarative
 * config produces canonical StreamEvents from realistic SSE input.
 */

function sseBody(messages: string[]): ReadableStream<Uint8Array> {
  const text = messages.map((d) => `data: ${d}\n\n`).join('');
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function mkFetch(body: ReadableStream<Uint8Array>): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '',
      body,
    }) as unknown as Response) as unknown as typeof fetch;
}

async function collectEvents(body: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const provider = new WireFormatProvider(mistralWireFormat, {
    apiKey: 'test-key',
    fetchImpl: mkFetch(body),
  });
  const events: StreamEvent[] = [];
  for await (const ev of provider.stream(
    { model: 'mistral-large-latest', messages: [], maxTokens: 100 },
    { signal: new AbortController().signal },
  )) {
    events.push(ev);
  }
  return events;
}

describe('Mistral preset', () => {
  it('parses text-only completion', async () => {
    const events = await collectEvents(
      sseBody([
        JSON.stringify({
          model: 'mistral-large-latest',
          choices: [{ delta: { content: 'Hello ' } }],
        }),
        JSON.stringify({ choices: [{ delta: { content: 'world' } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
        '[DONE]',
      ]),
    );

    const start = events.find((e) => e.type === 'message_start');
    expect(start).toBeDefined();
    expect((start as { model: string }).model).toBe('mistral-large-latest');

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { text: string }).text).toBe('Hello ');

    const stop = events.find((e) => e.type === 'message_stop');
    expect(stop).toBeDefined();
    expect((stop as { stopReason: string }).stopReason).toBe('stop_sequence');
    expect((stop as { usage: { input: number; output: number } }).usage).toEqual({
      input: 12,
      output: 3,
    });
  });

  it('parses streaming tool call with accumulated arguments', async () => {
    const events = await collectEvents(
      sseBody([
        JSON.stringify({
          model: 'mistral-large',
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_42', function: { name: 'search' } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 50, completion_tokens: 8 },
        }),
        '[DONE]',
      ]),
    );

    const toolStart = events.find((e) => e.type === 'tool_use_start');
    expect(toolStart).toEqual({ type: 'tool_use_start', id: 'call_42', name: 'search' });

    const deltas = events.filter((e) => e.type === 'tool_use_input_delta');
    expect(deltas).toHaveLength(2);

    const toolStop = events.find((e) => e.type === 'tool_use_stop');
    expect(toolStop).toBeDefined();
    expect((toolStop as { input: unknown }).input).toEqual({ q: 'hello' });

    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('tool_use');
  });

  it('maps finish_reason values to canonical StopReason', async () => {
    const cases: Array<[string, string]> = [
      ['stop', 'stop_sequence'],
      ['length', 'max_tokens'],
      ['tool_calls', 'tool_use'],
      ['other-unknown', 'end_turn'],
    ];
    for (const [wire, canonical] of cases) {
      const events = await collectEvents(
        sseBody([
          JSON.stringify({ model: 'm', choices: [{ delta: { content: 'x' } }] }),
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: wire }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          '[DONE]',
        ]),
      );
      const stop = events.find((e) => e.type === 'message_stop');
      expect((stop as { stopReason: string }).stopReason).toBe(canonical);
    }
  });

  it('ignores malformed SSE data without crashing', async () => {
    const events = await collectEvents(
      sseBody([
        'not-json-at-all',
        JSON.stringify({ model: 'm', choices: [{ delta: { content: 'recovered' } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        '[DONE]',
      ]),
    );

    const text = events.find((e) => e.type === 'text_delta');
    expect(text).toBeDefined();
  });

  it('preset declares the openai-compatible family and a stable id', () => {
    expect(mistralWireFormat.id).toBe('mistral');
    expect(mistralWireFormat.family).toBe('openai-compatible');
    expect(mistralWireFormat.capabilities.streaming).toBe(true);
  });
});
