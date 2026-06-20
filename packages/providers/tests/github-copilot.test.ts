import type { Request } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type CopilotTokenResult,
  copilotBaseUrlFromToken,
  GitHubCopilotProvider,
} from '../src/github-copilot.js';

const COPILOT_TOKEN = 'tid=abc;exp=9999;proxy-ep=proxy.individual.githubcopilot.com;ssc=1';

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

const OPENAI_SSE = [
  'data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

interface Captured {
  url?: string;
  init?: { headers?: Record<string, string>; body?: string };
}

function capturingFetch(body: string, captured: Captured, status = 200): typeof fetch {
  return (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    captured.url = url;
    captured.init = init;
    return new Response(status >= 200 && status < 300 ? sseBody(body) : 'err', { status });
  }) as unknown as typeof fetch;
}

const baseReq: Request = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};

describe('copilotBaseUrlFromToken', () => {
  it('derives the API base from proxy-ep', () => {
    expect(copilotBaseUrlFromToken(COPILOT_TOKEN)).toBe('https://api.individual.githubcopilot.com');
  });
  it('falls back to the individual endpoint', () => {
    expect(copilotBaseUrlFromToken(undefined)).toBe('https://api.individual.githubcopilot.com');
    expect(copilotBaseUrlFromToken('no-proxy-ep')).toBe('https://api.individual.githubcopilot.com');
  });
});

describe('GitHubCopilotProvider request shape', () => {
  it('targets the proxy-derived base with Copilot headers', async () => {
    const captured: Captured = {};
    const p = new GitHubCopilotProvider({
      credentials: {
        copilotToken: COPILOT_TOKEN,
        githubToken: 'gho_x',
        expiresAt: Date.now() + 3_600_000,
      },
      fetchImpl: capturingFetch(OPENAI_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(captured.url).toBe('https://api.individual.githubcopilot.com/chat/completions');
    const h = captured.init?.headers ?? {};
    expect(h['authorization']).toBe(`Bearer ${COPILOT_TOKEN}`);
    expect(h['Copilot-Integration-Id']).toBe('vscode-chat');
    expect(h['Editor-Version']).toBe('vscode/1.107.0');
    expect(h['X-GitHub-Api-Version']).toBe('2026-06-01');
  });
});

describe('GitHubCopilotProvider token refresh', () => {
  it('mints a fresh Copilot token when expired and persists', async () => {
    const captured: Captured = {};
    const newToken = 'tid=new;proxy-ep=proxy.business.githubcopilot.com;x=1';
    const refreshFn = vi.fn(
      async (): Promise<CopilotTokenResult> => ({
        token: newToken,
        expires: Date.now() + 3_600_000,
      }),
    );
    const onRefresh = vi.fn();
    const p = new GitHubCopilotProvider({
      credentials: {
        copilotToken: COPILOT_TOKEN,
        githubToken: 'gho_x',
        expiresAt: Date.now() - 1000,
      },
      refreshFn,
      onRefresh,
      fetchImpl: capturingFetch(OPENAI_SSE, captured),
    });
    await p.complete(baseReq, { signal: new AbortController().signal });

    expect(refreshFn).toHaveBeenCalledOnce();
    expect(captured.url).toBe('https://api.business.githubcopilot.com/chat/completions');
    expect(captured.init?.headers?.['authorization']).toBe(`Bearer ${newToken}`);
    expect(onRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: newToken, refreshToken: 'gho_x' }),
    );
  });

  it('refreshes once and retries on a 401', async () => {
    const refreshFn = vi.fn(
      async (): Promise<CopilotTokenResult> => ({
        token: COPILOT_TOKEN,
        expires: Date.now() + 3_600_000,
      }),
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('unauthorized', { status: 401 });
      return new Response(sseBody(OPENAI_SSE), { status: 200 });
    }) as unknown as typeof fetch;

    const p = new GitHubCopilotProvider({
      credentials: {
        copilotToken: COPILOT_TOKEN,
        githubToken: 'gho_x',
        expiresAt: Date.now() + 3_600_000,
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
