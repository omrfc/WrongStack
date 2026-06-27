/**
 * `github-copilot` wire family — GitHub Copilot subscription.
 *
 * Copilot's chat API is OpenAI chat/completions-compatible, so this extends
 * OpenAIProvider and only changes auth + base URL + headers:
 *   - `Authorization: Bearer <copilot-token>` plus the Copilot editor headers
 *     and `X-GitHub-Api-Version`.
 *   - The base URL is derived from the Copilot token's `proxy-ep=` field
 *     (e.g. https://api.individual.githubcopilot.com).
 *
 * Two tokens are involved: the long-lived GitHub OAuth token (stored as the
 * refresh token — it does NOT rotate) mints short-lived Copilot tokens via
 * `api.github.com/copilot_internal/v2/token`. This adapter refreshes the
 * Copilot token transparently (near-expiry + once on 401) and re-derives the
 * base URL from each new token. The API-key `openai` family is untouched.
 */

import type { Capabilities, Request } from '@wrongstack/core';
import { ProviderError } from '@wrongstack/core';
import { capabilitiesForFamily } from './family-capabilities.js';
import { openaiWireFormat } from './presets/openai.js';
import type { OpenAIStreamState } from './presets/openai.js';
import { WireFormatProvider } from './wire-format.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_API_VERSION = '2026-06-01';
const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};
const DEFAULT_API_BASE = 'https://api.individual.githubcopilot.com';
const REFRESH_SKEW_MS = 60_000;

/**
 * Allowed hostname suffixes for the Copilot `proxy-ep` token field.
 * Any other hostname (including IPs, private ranges, or unrelated domains)
 * is rejected and the default API base is used instead.
 * This prevents a malicious token with a crafted `proxy-ep` from redirecting
 * Copilot API traffic to an attacker-controlled server (SSRF).
 */
const SAFE_PROXY_EP_SUFFIXES = ['.githubcopilot.com'] as const;

/** Derive the Copilot API base URL from a Copilot token's `proxy-ep` field.
 *  Rejects hostnames that are not public Copilot endpoints (SSRF guard). */
export function copilotBaseUrlFromToken(token: string | undefined): string {
  if (token) {
    const m = token.match(/proxy-ep=([^;]+)/);
    if (m?.[1]) {
      const hostname = m[1].replace(/^proxy\./, 'api.');
      if (SAFE_PROXY_EP_SUFFIXES.some((s) => hostname.endsWith(s)) && !hostname.includes(':')) {
        return `https://${hostname}`;
      }
      // Unknown or private hostname — fall back to default rather than follow.
    }
  }
  return DEFAULT_API_BASE;
}

export interface CopilotTokenResult {
  /** The short-lived Copilot token (the access token used for chat). */
  token: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
}

/** Mint a fresh Copilot token from the long-lived GitHub OAuth token. */
export async function refreshCopilotToken(
  githubToken: string,
  signal?: AbortSignal,
): Promise<CopilotTokenResult> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${githubToken}`,
      ...COPILOT_HEADERS,
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Copilot token request failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as { token?: string; expires_at?: number } | null;
  if (!json?.token || typeof json.expires_at !== 'number') {
    throw new Error('Copilot token response missing fields');
  }
  return { token: json.token, expires: json.expires_at * 1000 };
}

export interface CopilotCredentials {
  /** Current Copilot token (access). May be empty → minted on first request. */
  copilotToken: string;
  /** Long-lived GitHub OAuth token (refresh; does not rotate). */
  githubToken?: string | undefined;
  /** Copilot-token expiry, epoch ms. */
  expiresAt?: number | undefined;
}

export interface GitHubCopilotProviderOptions {
  credentials: CopilotCredentials;
  id?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  onRefresh?:
    | ((creds: { accessToken: string; expiresAt: number }) => void)
    | undefined;
  refreshFn?:
    | ((githubToken: string, signal?: AbortSignal) => Promise<CopilotTokenResult>)
    | undefined;
}

export class GitHubCopilotProvider extends WireFormatProvider<OpenAIStreamState> {
  override readonly capabilities: Capabilities;

  private copilotToken: string;
  private readonly githubToken: string | undefined;
  private expiresAt: number | undefined;
  private apiBase: string;
  private readonly onRefresh: GitHubCopilotProviderOptions['onRefresh'];
  private readonly refreshFn: (
    githubToken: string,
    signal?: AbortSignal,
  ) => Promise<CopilotTokenResult>;

  constructor(opts: GitHubCopilotProviderOptions) {
    const apiBase = copilotBaseUrlFromToken(opts.credentials.copilotToken);
    super(openaiWireFormat, {
      apiKey: opts.credentials.copilotToken || 'pending',
      baseUrl: apiBase,
      fetchImpl: opts.fetchImpl,
      streamOpts: opts.streamOpts,
    });
    this.copilotToken = opts.credentials.copilotToken;
    this.githubToken = opts.credentials.githubToken;
    this.expiresAt = opts.credentials.expiresAt;
    this.apiBase = apiBase;
    this.onRefresh = opts.onRefresh;
    this.refreshFn = opts.refreshFn ?? refreshCopilotToken;
    this.capabilities = capabilitiesForFamily('github-copilot', { ...opts.capabilities });
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }) {
    await this.ensureFreshToken(opts.signal);
    try {
      yield* super.stream(req, opts);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401 && this.githubToken) {
        await this.doRefresh(opts.signal);
        yield* super.stream(req, opts);
        return;
      }
      throw err;
    }
  }

  private async ensureFreshToken(signal: AbortSignal): Promise<void> {
    const stale = this.expiresAt === undefined || Date.now() >= this.expiresAt - REFRESH_SKEW_MS;
    if (!this.copilotToken || (stale && this.githubToken)) {
      await this.doRefresh(signal);
    }
  }

  private async doRefresh(signal: AbortSignal): Promise<void> {
    if (!this.githubToken) return;
    const t = await this.refreshFn(this.githubToken, signal);
    this.copilotToken = t.token;
    this.expiresAt = t.expires;
    this.apiBase = copilotBaseUrlFromToken(t.token);
    this.onRefresh?.({
      accessToken: t.token,
      expiresAt: t.expires,
    });
  }

  protected override buildUrl(_req: Request): string {
    return `${this.apiBase.replace(/\/+$/, '')}/chat/completions`;
  }

  /**
   * Copilot uses the legacy `max_tokens` field (OpenAI Chat Completions v1)
   * rather than the newer `max_completion_tokens` that `openaiWireFormat`
   * sends. Override buildBody to fix the field name after the preset runs.
   */
  protected override buildBody(
    req: Request,
    ctx: { capabilities: Capabilities },
  ): Record<string, unknown> {
    const body = super.buildBody(req, ctx);
    // Rename max_completion_tokens → max_tokens for Copilot's API
    if ('max_completion_tokens' in body) {
      body['max_tokens'] = body['max_completion_tokens'];
      delete body['max_completion_tokens'];
    }
    return body;
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${this.copilotToken}`,
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
      ...COPILOT_HEADERS,
    };
  }
}
