/**
 * `anthropic-oauth` wire family — Claude Pro/Max via "Sign in with Claude".
 *
 * Same wire as the API-key `anthropic` family (api.anthropic.com/v1/messages),
 * but authenticated with an OAuth access token instead of an API key. Three
 * things differ from the API-key path, all REQUIRED for the subscription
 * backend to accept the request:
 *   1. `Authorization: Bearer <access>` (no `x-api-key`).
 *   2. `anthropic-beta: claude-code-20250219,oauth-2025-04-20`.
 *   3. The first system block MUST be exactly the Claude Code identity line —
 *      Anthropic rejects OAuth requests whose system prompt doesn't lead with it.
 *
 * The API-key `anthropic` family is untouched. Tokens self-refresh (near-expiry
 * + once on 401) via the refresh token; rotated tokens persist through the same
 * `setOAuthTokenPersister` hook the codex family uses.
 */

import { type Capabilities, ProviderError, type Request } from '@wrongstack/core';
import { AnthropicProvider } from './anthropic.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'claude-code-20250219,oauth-2025-04-20';
const REFRESH_SKEW_MS = 60_000;

/** Required first system block for OAuth/subscription requests. */
export const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export interface AnthropicOAuthTokens {
  access: string;
  refresh: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
}

/** Refresh an expired Claude OAuth access token. */
export async function refreshAnthropicOAuthToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<AnthropicOAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude token refresh failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('Claude token refresh response missing fields');
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export interface AnthropicOAuthCredentials {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
}

export interface AnthropicOAuthProviderOptions {
  credentials: AnthropicOAuthCredentials;
  baseUrl?: string | undefined;
  id?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  onRefresh?:
    | ((creds: { accessToken: string; refreshToken: string; expiresAt: number }) => void)
    | undefined;
  refreshFn?:
    | ((refreshToken: string, signal?: AbortSignal) => Promise<AnthropicOAuthTokens>)
    | undefined;
}

export class AnthropicOAuthProvider extends AnthropicProvider {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private access: string;
  private refresh: string | undefined;
  private expiresAt: number | undefined;
  private readonly onRefresh: AnthropicOAuthProviderOptions['onRefresh'];
  private readonly refreshFn: (
    refreshToken: string,
    signal?: AbortSignal,
  ) => Promise<AnthropicOAuthTokens>;

  constructor(opts: AnthropicOAuthProviderOptions) {
    super({
      apiKey: opts.credentials.accessToken,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE,
      fetchImpl: opts.fetchImpl,
      streamOpts: opts.streamOpts,
    });
    this.id = opts.id ?? 'anthropic-oauth';
    this.capabilities = capabilitiesForFamily('anthropic-oauth');
    this.access = opts.credentials.accessToken;
    this.refresh = opts.credentials.refreshToken;
    this.expiresAt = opts.credentials.expiresAt;
    this.onRefresh = opts.onRefresh;
    this.refreshFn = opts.refreshFn ?? refreshAnthropicOAuthToken;
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }) {
    await this.ensureFreshToken(opts.signal);
    try {
      yield* super.stream(req, opts);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401 && this.refresh) {
        await this.doRefresh(opts.signal);
        yield* super.stream(req, opts);
        return;
      }
      throw err;
    }
  }

  private async ensureFreshToken(signal: AbortSignal): Promise<void> {
    if (!this.refresh) return;
    if (this.expiresAt !== undefined && Date.now() < this.expiresAt - REFRESH_SKEW_MS) return;
    await this.doRefresh(signal);
  }

  private async doRefresh(signal: AbortSignal): Promise<void> {
    if (!this.refresh) return;
    const t = await this.refreshFn(this.refresh, signal);
    this.access = t.access;
    this.refresh = t.refresh;
    this.expiresAt = t.expires;
    this.onRefresh?.({ accessToken: t.access, refreshToken: t.refresh, expiresAt: t.expires });
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
      authorization: `Bearer ${this.access}`,
      'anthropic-beta': OAUTH_BETA,
    };
  }

  protected override buildBody(req: Request): Record<string, unknown> {
    const body = super.buildBody(req);
    // Prepend the required Claude Code identity block (unless already present).
    const existing = (body['system'] as { type: 'text'; text: string }[] | undefined) ?? [];
    const alreadyLed = existing[0]?.text?.startsWith(CLAUDE_CODE_SYSTEM_PROMPT) === true;
    body['system'] = alreadyLed
      ? existing
      : [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }, ...existing];
    return body;
  }
}
