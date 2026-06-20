import type { Request } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type CodexOAuthTokens,
  extractAccountId,
  OpenAICodexProvider,
  resolveCodexUrl,
} from '../src/openai-codex.js';

/** Build a fake JWT carrying a ChatGPT account-id claim. */
function fakeJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

interface Captured {
  url?: string;
  init?: { headers?: Record<string, string>; body?: string };
}

function capturingFetch(body: string, captured: Captured, status = 200): typeof fetch {
  return (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    captured.url = url;
    captured.init = init;
    return new Response(status >= 200 && status < 300 ? sseBody(body) : 'err', {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

const baseReq: Request = {
  model: 'gpt-5-codex',
  system: [{ type: 'text', text: 'Be terse.' }],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};

const COMPLETED_SSE = [
  'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
  '',
  'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
  '',
  'data: {"type":"response.output_text.delta","delta":"ok"}',
  '',
  'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1"}}',
  '',
  'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}',
  '',
].join('\n');

describe('extractAccountId', () => {
  it('pulls chatgpt_account_id from the JWT', () => {
    expect(extractAccountId(fakeJwt('acc_42'))).toBe('acc_42');
  });
  it('returns null for non-JWT / missing claim', () => {
    expect(extractAccountId('not-a-jwt')).toBeNull();
    expect(
      extractAccountId(
        `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.s`,
      ),
    ).toBeNull();
  });
});

describe('resolveCodexUrl', () => {
  it('normalizes to /codex/responses', () => {
    expect(resolveCodexUrl(undefined)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(resolveCodexUrl('https://chatgpt.com/backend-api')).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
    expect(resolveCodexUrl('https://example.com/backend-api/codex')).toBe(
      'https://example.com/backend-api/codex/responses',
    );
  });
});

describe('OpenAICodexProvider request shape', () => {
  it('sends Responses body + ChatGPT auth headers', async () => {
    const captured: Captured = {};
    const token = fakeJwt('acc_99');
    const p = new OpenAICodexProvider({
      credentials: { accessToken: token, expiresAt: Date.now() + 3_600_000 },
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(captured.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const h = captured.init?.headers ?? {};
    expect(h['authorization']).toBe(`Bearer ${token}`);
    expect(h['chatgpt-account-id']).toBe('acc_99');
    expect(h['originator']).toBe('wrongstack');
    expect(h['OpenAI-Beta']).toBe('responses=experimental');

    const body = JSON.parse(captured.init?.body ?? '{}');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe('Be terse.');
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  });
});

describe('OpenAICodexProvider stream parsing', () => {
  it('parses text + function_call into canonical content', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5-codex"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant"}}',
      '',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      '',
      'data: {"type":"response.output_text.delta","delta":" world"}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1"}}',
      '',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc1","call_id":"call_1","name":"get_weather"}}',
      '',
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\""}',
      '',
      'data: {"type":"response.function_call_arguments.delta","delta":":\\"NYC\\"}"}',
      '',
      'data: {"type":"response.function_call_arguments.done","arguments":"{\\"city\\":\\"NYC\\"}"}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}',
      '',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"input_tokens_details":{"cached_tokens":2}}}}',
      '',
    ].join('\n');

    const p = new OpenAICodexProvider({
      credentials: { accessToken: fakeJwt('a'), expiresAt: Date.now() + 3_600_000 },
      fetchImpl: (async () =>
        new Response(sseBody(sse), { status: 200 })) as unknown as typeof fetch,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(res.content).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toMatchObject({ input: 8, output: 5, cacheRead: 2 });
  });
});

describe('OpenAICodexProvider token refresh', () => {
  it('refreshes a near-expired token before the request and persists', async () => {
    const captured: Captured = {};
    const fresh = fakeJwt('acc_new');
    const refreshFn = vi.fn(
      async (): Promise<CodexOAuthTokens> => ({
        access: fresh,
        refresh: 'r2',
        expires: Date.now() + 3_600_000,
      }),
    );
    const onRefresh = vi.fn();
    const p = new OpenAICodexProvider({
      credentials: {
        accessToken: fakeJwt('acc_old'),
        refreshToken: 'r1',
        expiresAt: Date.now() - 1000, // already expired
      },
      refreshFn,
      onRefresh,
      fetchImpl: capturingFetch(COMPLETED_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(refreshFn).toHaveBeenCalledOnce();
    expect(captured.init?.headers?.['authorization']).toBe(`Bearer ${fresh}`);
    expect(captured.init?.headers?.['chatgpt-account-id']).toBe('acc_new');
    expect(onRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: fresh, refreshToken: 'r2', accountId: 'acc_new' }),
    );
  });

  it('refreshes once and retries on a 401', async () => {
    const fresh = fakeJwt('acc_new');
    const refreshFn = vi.fn(
      async (): Promise<CodexOAuthTokens> => ({
        access: fresh,
        refresh: 'r2',
        expires: Date.now() + 3_600_000,
      }),
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('unauthorized', { status: 401 });
      return new Response(sseBody(COMPLETED_SSE), { status: 200 });
    }) as unknown as typeof fetch;

    const p = new OpenAICodexProvider({
      credentials: {
        accessToken: fakeJwt('acc_old'),
        refreshToken: 'r1',
        expiresAt: Date.now() + 3_600_000, // not near expiry → no pre-flight refresh
      },
      refreshFn,
      fetchImpl,
    });
    const res = await p.complete(baseReq, { signal: new AbortController().signal });

    expect(calls).toBe(2);
    expect(refreshFn).toHaveBeenCalledOnce();
    expect(res.stopReason).toBe('end_turn');
  });
});
