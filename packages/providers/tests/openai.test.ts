import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/openai.js';

function mockFetch(json: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response);
}

describe('OpenAIProvider', () => {
  // Content-parsing tests live in streaming.test.ts since complete() wraps
  // stream() internally. This file covers headers, URLs, errors, and the
  // request-body shape.

  it('non-2xx becomes ProviderError', async () => {
    const fetchImpl = mockFetch({ error: 'auth' }, 401) as unknown as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('requires apiKey', () => {
    expect(() => new OpenAIProvider({ apiKey: '' })).toThrow(/apiKey required/);
  });

  it('marks 429 and 5xx as retryable', async () => {
    const fetchImpl = mockFetch({}, 429) as unknown as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 429, retryable: true });
  });

  it('wraps fetch network failure in ProviderError(retryable)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 0, retryable: true });
  });

  it('rethrows abort errors directly', async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(async () => {
      ctrl.abort();
      throw new Error('aborted');
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow(/aborted/);
  });

  it('includes tool_choice when set to named function', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'k' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 1,
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
        toolChoice: { type: 'tool', name: 'read' } as unknown as 'auto',
      },
      { signal: new AbortController().signal },
    );
    expect(captured?.['tool_choice']).toMatchObject({
      type: 'function',
      function: { name: 'read' },
    });
  });

  it('appends /chat/completions to z.ai-style versioned baseUrl', async () => {
    let calledUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'k' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider({
      apiKey: 'k',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      fetchImpl,
    });
    await p.complete(
      { model: 'glm-4.6', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(calledUrl).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
  });

  it('uses baseUrl with /chat/completions already as-is', async () => {
    let calledUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'k' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider({
      apiKey: 'k',
      baseUrl: 'https://example.com/v1/chat/completions',
      fetchImpl,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(calledUrl).toBe('https://example.com/v1/chat/completions');
  });

  it('adds organization header when set', async () => {
    const spy = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      return {
        ok: true,
        status: 200,
        headers: init?.headers,
        json: async () => ({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => '',
      };
    });
    const p = new OpenAIProvider({
      apiKey: 'k',
      organization: 'org-x',
      fetchImpl: spy as unknown as typeof fetch,
    });
    await p.complete(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      { signal: new AbortController().signal },
    );
    expect(
      (spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers['openai-organization'],
    ).toBe('org-x');
  });
});
