import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollForGitHubToken, startDeviceFlow } from '../src/auth-menu/github-copilot-oauth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startDeviceFlow', () => {
  it('POSTs to GitHub device-code and maps the response', async () => {
    let captured: { url?: string; body?: string } = {};
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
