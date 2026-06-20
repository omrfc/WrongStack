/**
 * `openai-codex` wire family — the ChatGPT-backend Responses API.
 *
 * This is the transport used by "Sign in with ChatGPT" (OAuth) credentials.
 * It speaks the OpenAI **Responses** wire format (NOT chat/completions) and
 * targets `https://chatgpt.com/backend-api/codex/responses`, authenticating
 * with the OAuth access token + `chatgpt-account-id` header. It deliberately
 * leaves the API-key `openai` family (api.openai.com/chat/completions)
 * untouched — the two coexist as separate providers.
 *
 * Token lifecycle: the access token is short-lived. This adapter refreshes it
 * transparently — before a request when it is near expiry, and once more on a
 * 401 — using the stored refresh token, then invokes `onRefresh` so the CLI
 * can persist the rotated tokens back to the vault.
 *
 * The refresh endpoint + client id are duplicated here (rather than imported
 * from the CLI) to respect the package layering: `providers` must not depend
 * on `cli`. They are tiny constants that match the CLI login module.
 */

import {
  type Capabilities,
  ProviderError,
  type Request,
  type StopReason,
  type StreamEvent,
  safeParse,
  type Usage,
} from '@wrongstack/core';
import { parseToolInput } from './_tool-input.js';
import { parseProviderHttpError } from './error-parse.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { parseSSE } from './sse.js';
import { messagesToResponsesInput, toolsToResponses } from './tool-format/to-responses.js';
import { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';

// ── OAuth refresh constants (mirror packages/cli auth-menu/openai-codex-oauth) ─

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const DEFAULT_CODEX_BASE = 'https://chatgpt.com/backend-api';
/** Refresh this many ms before the token's stated expiry. */
const REFRESH_SKEW_MS = 60_000;

export interface CodexOAuthTokens {
  access: string;
  refresh: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
}

/** Refresh an expired Codex access token using its refresh token. */
export async function refreshCodexAccessToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<CodexOAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex token refresh failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('Codex token refresh response missing fields');
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/** Extract `chatgpt_account_id` from an access-token JWT, or null. */
export function extractAccountId(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const auth = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

// ── Provider ────────────────────────────────────────────────────────────────

export interface CodexCredentials {
  /** The OAuth access token (a JWT). */
  accessToken: string;
  /** The refresh token, used to mint a new access token before/at expiry. */
  refreshToken?: string | undefined;
  /** Access-token expiry, epoch ms. When absent, refresh only fires on 401. */
  expiresAt?: number | undefined;
  /** Cached ChatGPT account id. Re-derived from the live token when missing. */
  accountId?: string | undefined;
}

export interface OpenAICodexProviderOptions {
  credentials: CodexCredentials;
  baseUrl?: string | undefined;
  id?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  /**
   * Persist rotated tokens after a successful refresh. The CLI wires this to
   * write back to the encrypted config so the new access/refresh pair survive
   * the session.
   */
  onRefresh?:
    | ((creds: {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        accountId: string | undefined;
      }) => void)
    | undefined;
  /** Override the refresh call (tests). */
  refreshFn?:
    | ((refreshToken: string, signal?: AbortSignal) => Promise<CodexOAuthTokens>)
    | undefined;
  /**
   * Reasoning effort for the Codex (gpt-5-codex) reasoning models. Sent as
   * `reasoning.effort` with `summary: 'auto'` so chain-of-thought streams back
   * as thinking deltas. Default 'medium'. Set 'none' to omit reasoning entirely.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | undefined;
}

export class OpenAICodexProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private access: string;
  private refresh: string | undefined;
  private expiresAt: number | undefined;
  private accountId: string | undefined;
  private readonly onRefresh: OpenAICodexProviderOptions['onRefresh'];
  private readonly refreshFn: (
    refreshToken: string,
    signal?: AbortSignal,
  ) => Promise<CodexOAuthTokens>;
  private readonly reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high';

  constructor(opts: OpenAICodexProviderOptions) {
    super(
      opts.credentials.accessToken,
      opts.baseUrl ?? DEFAULT_CODEX_BASE,
      opts.fetchImpl,
      opts.streamOpts,
    );
    this.id = opts.id ?? 'openai-codex';
    this.access = opts.credentials.accessToken;
    this.refresh = opts.credentials.refreshToken;
    this.expiresAt = opts.credentials.expiresAt;
    this.accountId = opts.credentials.accountId ?? extractAccountId(this.access) ?? undefined;
    this.onRefresh = opts.onRefresh;
    this.refreshFn = opts.refreshFn ?? refreshCodexAccessToken;
    this.reasoningEffort = opts.reasoningEffort ?? 'medium';
    this.capabilities = capabilitiesForFamily('openai-codex', { ...opts.capabilities });
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    await this.ensureFreshToken(opts.signal);
    try {
      yield* super.stream(req, opts);
    } catch (err) {
      // A 401 means the token went stale between the pre-flight check and the
      // request (or we had no expiry to check). Refresh once and retry — the
      // error is thrown before any StreamEvent is emitted, so no output is
      // duplicated.
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
    this.accountId = extractAccountId(t.access) ?? this.accountId;
    this.onRefresh?.({
      accessToken: t.access,
      refreshToken: t.refresh,
      expiresAt: t.expires,
      accountId: this.accountId,
    });
  }

  protected override buildUrl(_req: Request): string {
    return resolveCodexUrl(this.baseUrl);
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    const headers: Record<string, string> = {
      ...super.buildHeaders(_req),
      authorization: `Bearer ${this.access}`,
      originator: 'wrongstack',
      'OpenAI-Beta': 'responses=experimental',
    };
    if (this.accountId) headers['chatgpt-account-id'] = this.accountId;
    return headers;
  }

  protected override buildBody(req: Request): Record<string, unknown> {
    const instructions =
      req.system && req.system.length > 0
        ? req.system.map((b) => b.text).join('\n\n')
        : 'You are a helpful assistant.';

    const body: Record<string, unknown> = {
      model: req.model,
      // The ChatGPT Codex backend rejects `store: true` ("Store must be set to
      // false"). We send the full conversation as `input` each turn.
      store: false,
      stream: true,
      instructions,
      input: messagesToResponsesInput(req.messages),
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
    };

    if (req.tools && req.tools.length > 0) {
      body['tools'] = toolsToResponses(req.tools);
      body['tool_choice'] = mapToolChoice(req.toolChoice);
    }
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (this.reasoningEffort !== 'none') {
      body['reasoning'] = { effort: this.reasoningEffort, summary: 'auto' };
    }
    return body;
  }

  protected override parseStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return parseCodexResponsesStream(body, fallbackModel);
  }

  protected override translateError(status: number, text: string): ProviderError {
    return parseProviderHttpError(this.id, status, text);
  }
}

// ── URL + tool-choice helpers ────────────────────────────────────────────────

/** Normalize a base URL to the `/codex/responses` endpoint. */
export function resolveCodexUrl(baseUrl: string | undefined): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE;
  const normalized = raw.replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function mapToolChoice(
  choice: Request['toolChoice'],
): 'auto' | 'required' | 'none' | { type: 'function'; name: string } {
  if (choice === undefined) return 'auto';
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}

// ── Responses SSE → StreamEvent ──────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

async function* parseCodexResponsesStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
  fallbackModel: string,
): AsyncIterable<StreamEvent> {
  let model = fallbackModel;
  let started = false;
  let usage: Usage = { input: 0, output: 0 };
  let stopReason: StopReason = 'end_turn';
  let sawToolUse = false;

  // Currently-streaming function call (Responses streams one item at a time).
  let toolCallId: string | undefined;
  let toolArgBuf = '';

  const ensureStart = (): StreamEvent | undefined => {
    if (started) return undefined;
    started = true;
    return { type: 'message_start', model };
  };

  for await (const msg of parseSSE(body)) {
    if (!msg.data || msg.data === '[DONE]') continue;
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) continue;
    const evt = parsed.value;
    const type = typeof evt['type'] === 'string' ? (evt['type'] as string) : '';

    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const resp = evt['response'] as { model?: string } | undefined;
        if (typeof resp?.model === 'string') model = resp.model;
        const s = ensureStart();
        if (s) yield s;
        break;
      }

      case 'response.output_item.added': {
        const s = ensureStart();
        if (s) yield s;
        const item = evt['item'] as
          | { type?: string; id?: string; call_id?: string; name?: string; arguments?: string }
          | undefined;
        if (!item) break;
        if (item.type === 'reasoning') {
          yield { type: 'thinking_start' };
        } else if (item.type === 'function_call') {
          toolCallId = item.call_id ?? item.id ?? `call_${Math.random().toString(36).slice(2)}`;
          toolArgBuf = item.arguments ?? '';
          sawToolUse = true;
          yield { type: 'tool_use_start', id: toolCallId, name: item.name ?? 'unknown' };
          if (toolArgBuf.length > 0) {
            yield { type: 'tool_use_input_delta', id: toolCallId, partial: toolArgBuf };
          }
        }
        // item.type === 'message' → text flows via output_text.delta
        break;
      }

      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (delta) yield { type: 'text_delta', text: delta };
        break;
      }

      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (delta) yield { type: 'thinking_delta', text: delta };
        break;
      }

      case 'response.function_call_arguments.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (toolCallId && delta) {
          toolArgBuf += delta;
          yield { type: 'tool_use_input_delta', id: toolCallId, partial: delta };
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        // Final arguments authoritative — captured at output_item.done below.
        const args =
          typeof evt['arguments'] === 'string' ? (evt['arguments'] as string) : undefined;
        if (args !== undefined) toolArgBuf = args;
        break;
      }

      case 'response.output_item.done': {
        const item = evt['item'] as
          | { type?: string; id?: string; call_id?: string; name?: string; arguments?: string }
          | undefined;
        if (!item) break;
        if (item.type === 'reasoning') {
          yield { type: 'thinking_stop' };
        } else if (item.type === 'function_call') {
          const id = item.call_id ?? toolCallId ?? `call_${Math.random().toString(36).slice(2)}`;
          const raw = item.arguments && item.arguments.length > 0 ? item.arguments : toolArgBuf;
          yield { type: 'tool_use_stop', id, input: parseToolInput(raw || '{}') };
          toolCallId = undefined;
          toolArgBuf = '';
        }
        break;
      }

      case 'response.completed':
      case 'response.incomplete': {
        const resp = evt['response'] as { status?: string; usage?: ResponsesUsage } | undefined;
        if (resp?.usage) usage = normalizeUsage(resp.usage);
        stopReason = mapResponsesStatus(resp?.status, sawToolUse);
        break;
      }

      case 'error':
      case 'response.failed': {
        const message =
          (evt['message'] as string | undefined) ??
          (evt['response'] as { error?: { message?: string } } | undefined)?.error?.message ??
          'Codex response failed';
        throw new ProviderError(message, 502, true, 'openai-codex', {
          body: { message },
        });
      }

      default:
        break;
    }
  }

  if (started) {
    yield { type: 'message_stop', stopReason, usage };
  }
}

function normalizeUsage(u: ResponsesUsage): Usage {
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const total = u.input_tokens ?? 0;
  return {
    input: Math.max(0, total - cached),
    output: u.output_tokens ?? 0,
    cacheRead: cached || undefined,
  };
}

function mapResponsesStatus(status: string | undefined, sawToolUse: boolean): StopReason {
  if (status === 'incomplete') return 'max_tokens';
  // 'completed' (and anything else benign) → tool_use when a call was emitted.
  return sawToolUse ? 'tool_use' : 'end_turn';
}
