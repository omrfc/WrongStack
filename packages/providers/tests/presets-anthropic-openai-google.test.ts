import type { StreamEvent } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { anthropicWireFormat } from '../src/presets/anthropic.js';
import { googleWireFormat } from '../src/presets/google.js';
import { openaiWireFormat } from '../src/presets/openai.js';
import { WireFormatProvider } from '../src/wire-format.js';

/**
 * Parity tests: the L0-C presets must produce the same canonical
 * StreamEvent[] as the existing class-based providers. We don't re-run the
 * full provider test suite per preset — instead we feed each preset a
 * representative SSE stream and assert the event shape.
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

async function collectFromPreset(
  format: Parameters<typeof WireFormatProvider>[0],
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<StreamEvent[]> {
  const provider = new WireFormatProvider(format, {
    apiKey: 'k',
    fetchImpl: mkFetch(body),
  });
  const events: StreamEvent[] = [];
  for await (const ev of provider.stream(
    { model, messages: [], maxTokens: 100 },
    { signal: new AbortController().signal },
  )) {
    events.push(ev);
  }
  return events;
}

describe('Anthropic preset', () => {
  it('emits message_start with model from message_start frame', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 11 } },
        }),
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 4 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'fallback-model',
    );
    const start = events.find((e) => e.type === 'message_start');
    expect((start as { model: string }).model).toBe('claude-3-5-sonnet');
    const text = events.find((e) => e.type === 'text_delta');
    expect((text as { text: string }).text).toBe('hello');
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('end_turn');
    expect((stop as { usage: { input: number; output: number } }).usage).toEqual({
      input: 11,
      output: 4,
    });
  });

  it('emits tool_use_start / input_delta / tool_use_stop for tool blocks', async () => {
    const events = await collectFromPreset(
      anthropicWireFormat,
      sseBody([
        JSON.stringify({
          type: 'message_start',
          message: { model: 'c', usage: { input_tokens: 1 } },
        }),
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"text":' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"hi"}' },
        }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 2 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
      'm',
    );
    const tStart = events.find((e) => e.type === 'tool_use_start');
    expect(tStart).toEqual({ type: 'tool_use_start', id: 'toolu_1', name: 'echo' });
    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect((tStop as { input: unknown }).input).toEqual({ text: 'hi' });
  });

  it('config metadata', () => {
    expect(anthropicWireFormat.id).toBe('anthropic');
    expect(anthropicWireFormat.family).toBe('anthropic');
    expect(anthropicWireFormat.capabilities.cacheControl).toBe('native');
  });
});

describe('OpenAI preset', () => {
  it('streams content + tool call + finish_reason', async () => {
    const events = await collectFromPreset(
      openaiWireFormat,
      sseBody([
        JSON.stringify({ model: 'gpt-4o', choices: [{ delta: { content: 'hi ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'there' } }] }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_a', function: { name: 'lookup', arguments: '{"q":' } },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        '[DONE]',
      ]),
      'gpt-4o',
    );
    const start = events.find((e) => e.type === 'message_start');
    expect((start as { model: string }).model).toBe('gpt-4o');
    const texts = events.filter((e) => e.type === 'text_delta');
    expect(texts).toHaveLength(2);
    const tStart = events.find((e) => e.type === 'tool_use_start');
    expect(tStart).toEqual({ type: 'tool_use_start', id: 'call_a', name: 'lookup' });
    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect((tStop as { input: unknown }).input).toEqual({ q: 'x' });
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('tool_use');
  });

  it('config metadata', () => {
    expect(openaiWireFormat.id).toBe('openai');
    expect(openaiWireFormat.family).toBe('openai');
  });
});

describe('Google preset', () => {
  it('forces tool_use stop reason when a functionCall part was seen', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini-2.0-flash',
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'lookup', args: { q: 'hello' } } }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
        }),
      ]),
      'gemini-flash',
    );
    const tStart = events.find((e) => e.type === 'tool_use_start');
    expect((tStart as { name: string }).name).toBe('lookup');
    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect((tStop as { input: { q: string } }).input).toEqual({ q: 'hello' });
    const stop = events.find((e) => e.type === 'message_stop');
    // STOP would map to end_turn, but the preset overrides to tool_use
    // because we saw a functionCall part — same behavior as GoogleProvider.
    expect((stop as { stopReason: string }).stopReason).toBe('tool_use');
  });

  it('emits text_delta for text parts', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini-2.0-flash',
          candidates: [
            { content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ]),
      'gemini',
    );
    const text = events.find((e) => e.type === 'text_delta');
    expect((text as { text: string }).text).toBe('hi');
    const stop = events.find((e) => e.type === 'message_stop');
    expect((stop as { stopReason: string }).stopReason).toBe('end_turn');
  });

  it('preserves thoughtSignature in providerMeta', async () => {
    const events = await collectFromPreset(
      googleWireFormat,
      sseBody([
        JSON.stringify({
          modelVersion: 'gemini-2.0-flash',
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'doit', args: {} },
                    thoughtSignature: 'opaque-signature-blob',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ]),
      'gemini',
    );
    const tStop = events.find((e) => e.type === 'tool_use_stop');
    expect(
      (tStop as { providerMeta?: Record<string, unknown> }).providerMeta?.[
        'google.thoughtSignature'
      ],
    ).toBe('opaque-signature-blob');
  });

  it('config metadata', () => {
    expect(googleWireFormat.id).toBe('google');
    expect(googleWireFormat.family).toBe('google');
    expect(googleWireFormat.capabilities.maxContext).toBe(1_000_000);
  });
});
