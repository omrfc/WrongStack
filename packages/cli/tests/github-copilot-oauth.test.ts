import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isUsableCopilotChatModel,
  pollForGitHubToken,
  startDeviceFlow,
} from '../src/auth-menu/github-copilot-oauth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startDeviceFlow', () => {
  it('POSTs to GitHub device-code and maps the response', async () => {
    let captured: {
      url: string | undefined;
      body: string | undefined;
    } = {
      url: undefined,
      body: undefined,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string }) => {
        captured = { url, body: init.body };
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'WXYZ-1234',
            verification_uri: 'https://github.com/login/device',
            interval: 5,
            expires_in: 900,
          }),
          { status: 200 },
        );
      }),
    );

    const d = await startDeviceFlow();
    expect(captured.url).toBe('https://github.com/login/device/code');
    const body = new URLSearchParams(captured.body ?? '');
    expect(body.get('client_id')).toBe('Iv1.b507a08c87ecfe98');
    expect(body.get('scope')).toBe('read:user');
    expect(d.user_code).toBe('WXYZ-1234');
    expect(d.device_code).toBe('dc');
  });
});

describe('isUsableCopilotChatModel', () => {
  const chat = (over: Record<string, unknown> = {}) => ({
    id: 'm',
    capabilities: { type: 'chat', supports: { tool_calls: true } },
    ...over,
  });

  it('keeps a normal enabled chat model with tool calls', () => {
    expect(isUsableCopilotChatModel(chat())).toBe(true);
  });

  it('keeps a legacy chat model with no supported_endpoints field', () => {
    expect(isUsableCopilotChatModel(chat({ id: 'gpt-4o' }))).toBe(true);
  });

  it('drops a /responses-only model (the picker 400 bug)', () => {
    // mai-code-1-flash-picker / gpt-5.4-mini-free-auto shape: chat + tools but
    // only callable via /responses, so /chat/completions returns HTTP 400.
    const picker = chat({ id: 'mai-code-1-flash-picker', supported_endpoints: ['/responses'] });
    expect(isUsableCopilotChatModel(picker)).toBe(false);
  });

  it('keeps a model whose supported_endpoints include /chat/completions', () => {
    const m = chat({ supported_endpoints: ['/chat/completions', '/responses'] });
    expect(isUsableCopilotChatModel(m)).toBe(true);
  });

  it('drops embedding and completion-only models', () => {
    expect(
      isUsableCopilotChatModel({
        id: 'text-embedding-3-small',
        capabilities: { type: 'embeddings', supports: {} },
      }),
    ).toBe(false);
    expect(
      isUsableCopilotChatModel({
        id: 'gpt-41-copilot',
        capabilities: { type: 'completion', supports: { tool_calls: true } },
      }),
    ).toBe(false);
  });

  it('drops models without tool-call support', () => {
    expect(
      isUsableCopilotChatModel({ id: 'm', capabilities: { type: 'chat', supports: {} } }),
    ).toBe(false);
  });

  it('drops policy-disabled models (not enabled in GitHub settings)', () => {
    expect(isUsableCopilotChatModel(chat({ policy: { state: 'disabled' } }))).toBe(false);
    expect(isUsableCopilotChatModel(chat({ policy: { state: 'enabled' } }))).toBe(true);
  });

  it('drops experimental internal models', () => {
    expect(isUsableCopilotChatModel(chat({ vendor: 'Experimental' }))).toBe(false);
  });

  it('drops entries with no id', () => {
    expect(isUsableCopilotChatModel(chat({ id: undefined }))).toBe(false);
  });
});

describe('pollForGitHubToken', () => {
  it('keeps polling on authorization_pending then returns the token', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(
          JSON.stringify(
            calls === 1 ? { error: 'authorization_pending' } : { access_token: 'gho_TOKEN' },
          ),
          { status: 200 },
        );
      }),
    );

    const token = await pollForGitHubToken(
      {
        device_code: 'dc',
        user_code: 'x',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 60,
      },
      new AbortController().signal,
    );
    expect(token).toBe('gho_TOKEN');
    expect(calls).toBe(2);
  });

  it('throws on a hard error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'access_denied' }), { status: 200 })),
    );
    await expect(
      pollForGitHubToken(
        {
          device_code: 'dc',
          user_code: 'x',
          verification_uri: 'https://github.com/login/device',
          interval: 0,
          expires_in: 60,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/access_denied/);
  });
});
