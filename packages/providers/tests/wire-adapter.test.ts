import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/openai.js';

// WireAdapter is abstract — concrete providers exercise its code paths.
// We test the uncovered lines through provider subclasses.

function mockFetch(json: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    body: null,
  } as never as Response);
}

describe('WireAdapter — coverage of abstract base paths', () => {
  // Line 56: constructor throws on empty apiKey (falsy check: !apiKey)
  it('constructor throws when apiKey is empty string', () => {
    expect(() => new OpenAIProvider({ apiKey: '' })).toThrow(/apiKey required/);
  });

  it('translateError creates ProviderError with correct providerId from OpenAIProvider', async () => {
    // Lines 118-120: translateError delegates to parseProviderHttpError with this.id
    const fetchImpl = mockFetch({ error: 'auth' }, 401) as never as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 401, providerId: 'openai' });
  });

  it('translateError is called for 5xx errors', async () => {
    const fetchImpl = mockFetch({}, 502) as never as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('complete() yields empty text content from empty SSE stream', async () => {
    // Lines 59-62: complete() imports aggregateStream and calls it on stream()
    // Exercise stream() path when body yields no events
    const fetchImpl = vi.fn(async () =>
      new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ) as never as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    const res = await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    // Empty stream → aggregateStream adds { type: 'text', text: '' }
    expect(res.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('buildHeaders returns content-type and accept headers (line 101-106)', async () => {
    let capturedHeaders: Record<string, string> = {};
    const capturingFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      capturedHeaders = (init.headers as Record<string, string>) ?? {};
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: [DONE]\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as never as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl: capturingFetch });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(capturedHeaders['content-type']).toBe('application/json');
    expect(capturedHeaders['accept']).toBe('text/event-stream');
  });
});