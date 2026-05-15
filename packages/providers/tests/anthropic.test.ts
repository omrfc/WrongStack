import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';

function mockFetch(json: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response);
}

describe('AnthropicProvider', () => {
  // Content-parsing tests live in streaming.test.ts since complete() now
  // wraps stream() internally and content parsing happens in the SSE
  // pipeline, not from a JSON body. This file covers everything else.

  it('throws ProviderError on non-2xx', async () => {
    const fetchImpl = mockFetch({ error: 'rate' }, 429) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('requires apiKey', () => {
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrow(/apiKey required/);
  });

  it('adds anthropic-beta header when set', async () => {
    const spy = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      headers: init?.headers,
      json: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => '',
    }));
    const p = new AnthropicProvider({
      apiKey: 'k',
      beta: ['prompt-caching-2024-07-31', 'tools-2024-04-04'],
      fetchImpl: spy as unknown as typeof fetch,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    const hdrs = (spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(hdrs['anthropic-beta']).toBe('prompt-caching-2024-07-31,tools-2024-04-04');
    expect(hdrs['x-api-key']).toBe('k');
  });

  it('serialises system, tools, temperature, topP, stopSequences', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        system: [{ type: 'text', text: 'be terse' }],
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ['<end>'],
        tools: [
          {
            name: 'read',
            description: '',
            inputSchema: { type: 'object' },
            permission: 'auto',
            mutating: false,
            async execute() {
              return '';
            },
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(body?.['system']).toEqual([{ type: 'text', text: 'be terse' }]);
    expect(body?.['temperature']).toBe(0.2);
    expect(body?.['top_p']).toBe(0.9);
    expect(body?.['stop_sequences']).toEqual(['<end>']);
    expect(body?.['tools'] as unknown[]).toHaveLength(1);
  });

  it('non-2xx with 500 is retryable', async () => {
    const fetchImpl = mockFetch({}, 500) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 500, retryable: true });
  });

  it('uses correct URL for baseUrl already ending in /v1 (e.g. minimax models.dev)', async () => {
    let calledUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://api.minimax.io/anthropic/v1',
      fetchImpl,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(calledUrl).toBe('https://api.minimax.io/anthropic/v1/messages');
  });

  it('appends /v1/messages to bare host baseUrls', async () => {
    let calledUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [], stop_reason: 'end_turn', usage: {} }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://example.com',
      fetchImpl,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(calledUrl).toBe('https://example.com/v1/messages');
  });

  it('accepts baseUrl with /v1/messages already', async () => {
    let calledUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [], stop_reason: 'end_turn', usage: {} }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://example.com/v1/messages',
      fetchImpl,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(calledUrl).toBe('https://example.com/v1/messages');
  });

  it('wraps fetch network error in ProviderError(retryable)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 0, retryable: true });
  });
});
