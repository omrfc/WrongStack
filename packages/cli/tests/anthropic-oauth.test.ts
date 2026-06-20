import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkce,
  parseAuthorizationInput,
} from '../src/auth-menu/anthropic-oauth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generatePkce', () => {
  it('produces a base64url verifier with a matching S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });
});

describe('buildAuthorizeUrl', () => {
  it('uses claude.ai, code=true, and the verifier as state', () => {
    const url = new URL(buildAuthorizeUrl('CHAL', 'VERIFIER'));
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    const p = url.searchParams;
    expect(p.get('code')).toBe('true');
    expect(p.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(p.get('redirect_uri')).toBe('http://localhost:53692/callback');
    expect(p.get('code_challenge')).toBe('CHAL');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('VERIFIER');
    expect(p.get('scope')).toContain('user:inference');
  });
});

describe('parseAuthorizationInput', () => {
  it('parses a redirect URL, bare query, and bare code', () => {
    expect(parseAuthorizationInput('http://localhost:53692/callback?code=a&state=b')).toEqual({
      code: 'a',
      state: 'b',
    });
    expect(parseAuthorizationInput('code=a&state=b')).toEqual({ code: 'a', state: 'b' });
    expect(parseAuthorizationInput('rawcode#st')).toEqual({ code: 'rawcode', state: 'st' });
  });
});

describe('exchangeAuthorizationCode', () => {
  it('POSTs a JSON authorization_code body and maps tokens', async () => {
    let captured: { url?: string; body?: string; contentType?: string } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
        captured = {
          url,
          body: init.body,
          contentType: init.headers?.['content-type'],
        };
        return new Response(
          JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
          { status: 200 },
        );
      }),
    );

    const tokens = await exchangeAuthorizationCode('CODE', 'STATE', 'VERIFIER');
    expect(captured.url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(captured.contentType).toBe('application/json');
    const body = JSON.parse(captured.body ?? '{}');
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      code: 'CODE',
      state: 'STATE',
      redirect_uri: 'http://localhost:53692/callback',
      code_verifier: 'VERIFIER',
    });
    expect(tokens.access).toBe('AT');
    expect(tokens.refresh).toBe('RT');
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 })),
    );
    await expect(exchangeAuthorizationCode('C', 'S', 'V')).rejects.toThrow(
      /token exchange failed/i,
    );
  });
});
