import type { ContentBlock, TextBlock } from './blocks.js';
import type { ErrorCode } from './errors.js';
import { WrongStackError, ERROR_CODES } from './errors.js';
import type { Message } from './messages.js';
import type { Tool } from './tool.js';
import { truncate } from '../utils/string.js';

/**
 * Token usage for a single provider call, normalized across providers.
 *
 * Disjoint semantics: the four fields never overlap. `input` is the count
 * of FRESH input tokens (billed at the full input rate); `cacheRead` and
 * `cacheWrite` are separate cached subsets each priced at their own rate.
 * The total context the model loaded for this turn is
 * `input + (cacheRead ?? 0) + (cacheWrite ?? 0)`.
 *
 * Provider quirks normalized at the adapter layer:
 *  - Anthropic: returns `input_tokens` already disjoint from cache fields.
 *  - OpenAI / OpenAI-compatible: `prompt_tokens` is the TOTAL including
 *    cached portion; the adapter subtracts `cached_tokens` to stay disjoint.
 *  - Google: `promptTokenCount` likewise includes cache; adapter subtracts
 *    `cachedContentTokenCount`.
 *
 * Cost math and the context-fullness chip both depend on the disjoint
 * invariant — a TOTAL `input` plus a separate `cacheRead` count would bill
 * cached tokens twice and skew cache-hit-ratio reporting.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CacheTtl = '5m' | '1h';

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  /** Back-compat aggregate of all cache-write tokens. Prefer TTL-specific fields when present. */
  cacheWrite?: number | undefined;
  cacheWrite5m?: number | undefined;
  cacheWrite1h?: number | undefined;
}

export interface ReasoningRequest {
  enabled?: boolean | undefined;
  effort?: ReasoningEffort | undefined;
  preserve?: boolean | undefined;
  display?: 'summarized' | 'omitted' | undefined;
}

export interface RequestCacheControl {
  ttl?: CacheTtl | undefined;
}

export interface ReasoningConfig {
  default: 'enabled' | 'disabled' | 'adaptive' | 'always_on';
  disableSupported: boolean;
  effortSupported: boolean;
  effortLevels: ReasoningEffort[];
  preserveThinking: 'unsupported' | 'optional' | 'always_on';
}

export interface Capabilities {
  tools: boolean;
  parallelTools: boolean;
  vision: boolean;
  streaming: boolean;
  promptCache: boolean;
  systemPrompt: boolean;
  jsonMode: boolean;
  reasoning: boolean;
  maxContext: number;
  cacheControl: 'native' | 'auto' | 'none';
}

export interface Request {
  model: string;
  system?: TextBlock[] | undefined;
  messages: Message[];
  tools?: Tool[] | undefined;
  maxTokens: number;
  temperature?: number | undefined;
  topP?: number | undefined;
  stopSequences?: string[] | undefined;
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool' | undefined; name: string };
  reasoning?: ReasoningRequest | undefined;
  cache?: RequestCacheControl | undefined;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface Response {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
}

export type StreamEvent =
  | { type: 'message_start'; model: string }
  | {
      type: 'content_block_start';
      kind: 'text' | 'tool_use' | 'thinking';
      id?: string | undefined;
      name?: string | undefined;
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partial: string }
  | { type: 'tool_use_stop'; id: string; input: unknown; providerMeta?: Record<string, unknown> }
  | { type: 'thinking_start'; providerMeta?: Record<string, unknown> }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_signature'; signature: string }
  | { type: 'thinking_stop' }
  | { type: 'message_stop'; stopReason: StopReason; usage: Usage };

export interface Provider {
  readonly id: string;
  readonly capabilities: Capabilities;
  /** Canonical streaming entry point. `complete()` defaults to a wrapper that
   * aggregates this stream — providers may override for non-streaming wires. */
  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent>;
  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response>;
}

/**
 * Structured body parsed from a provider's HTTP error response. Populated
 * best-effort: providers return JSON shaped differently (Anthropic uses
 * `{error: {type, message}}`, OpenAI uses `{error: {message, code}}`,
 * Google uses `{error: {status, message}}`), so the fields here are the
 * intersection that's usable for rendering and routing.
 */
export interface ProviderErrorBody {
  /** Provider-specific kind, e.g. "overloaded_error", "rate_limit_error", "invalid_request_error". */
  type?: string | undefined;
  /** Human-readable explanation from the provider. */
  message?: string | undefined;
  /** Provider request id, when present in the body or headers. */
  requestId?: string | undefined;
  /** Parsed Retry-After header (or equivalent body hint) in milliseconds. */
  retryAfterMs?: number | undefined;
  /** The raw response body (truncated to ~2 KB), kept for debugging. */
  raw?: string | undefined;
  /** True when `raw` was truncated; check `rawLength` for the original size. */
  truncated?: boolean | undefined;
  /** Original length of the response body in bytes, when `truncated` is true. */
  rawLength?: number | undefined;
}

export class ProviderError extends WrongStackError {
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly providerId: string;
  public readonly body?: ProviderErrorBody | undefined;

  constructor(
    message: string,
    status: number,
    retryable: boolean,
    providerId: string,
    opts: { body?: ProviderErrorBody | undefined; cause?: unknown | undefined } = {},
  ) {
    super({
      message,
      code: providerStatusToCode(status, opts.body?.type),
      subsystem: 'provider',
      severity: status >= 500 ? 'error' : 'warning',
      recoverable: retryable,
      context: { providerId, status },
      cause: opts.cause,
    });
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.providerId = providerId;
    this.body = opts.body;
  }

  /**
   * Render a one-line, user-facing description. Designed for the CLI/TUI
   * status line and the agent's retry warning. Avoids dumping raw JSON
   * (which is what users see today when a 529 lands and the log message
   * includes the full `{"type":"error",...}` body).
   *
   * Examples:
   *   "minimax-coding-plan overloaded (529): High traffic detected. Upgrade for highspeed model. [req 06534785201de9c0…]"
   *   "openai rate limited (429): Retry after 12s"
   *   "anthropic invalid request (400): messages.0.role must be one of 'user'|'assistant'"
   *   "groq HTTP 500 (server error)"
   */
  override describe(): string {
    const kind = describeStatus(this.status, this.body?.type);
    const head = `${this.providerId} ${kind}`;
    const detail = this.body?.message?.trim();
    const reqId = this.body?.requestId
      ? ` [req ${this.body.requestId.slice(0, 16)}${this.body.requestId.length > 16 ? '…' : ''}]`
      : '';
    if (detail && detail.length > 0) {
      return `${head}: ${truncate(detail, 240)}${reqId}`;
    }
    return `${head}${reqId}`;
  }
}

function describeStatus(status: number, type?: string): string {
  if (status === 0) return 'network error';
  if (type === 'overloaded_error' || status === 529) return `overloaded (${status})`;
  if (type === 'rate_limit_error' || status === 429) return `rate limited (${status})`;
  if (type === 'authentication_error' || status === 401) return `auth failed (${status})`;
  if (type === 'permission_error' || status === 403) return `forbidden (${status})`;
  if (type === 'not_found_error' || status === 404) return `not found (${status})`;
  if (type === 'invalid_request_error' || status === 400) return `invalid request (${status})`;
  if (status === 408) return `timeout (${status})`;
  if (status >= 500 && status < 600) return `HTTP ${status} (server error)`;
  if (type) return `${type} (${status})`;
  return `HTTP ${status}`;
}

/**
 * Thrown when the provider stream stops delivering data mid-response.
 * This is distinct from a network error (TCP reset, DNS failure) — the
 * connection is established and the response started, but chunks stopped
 * arriving before the stream completed.
 *
 * Status 599 is used as a sentinel to distinguish stream hangs from
 * regular HTTP errors while still flowing through ProviderError-based
 * retry and fallback infrastructure.
 */
export class StreamHangError extends ProviderError {
  /** Name of the provider that hung, e.g. "zai", "anthropic". */
  public readonly hungProviderId: string;
  /** Model that was being called when the hang occurred. */
  public readonly hungModel: string;
  /** How long (ms) we waited for the next chunk before declaring a hang. */
  public readonly hangTimeoutMs: number;
  /** How many bytes were received before the hang. */
  public readonly bytesReceived: number;
  /** Elapsed time (ms) from the start of the stream until the hang. */
  public readonly elapsedMs: number;

  constructor(opts: {
    providerId: string;
    model: string;
    hangTimeoutMs: number;
    bytesReceived: number;
    elapsedMs: number;
    cause?: unknown | undefined;
  }) {
    super(
      `Stream hang: ${opts.providerId}/${opts.model} — no data for ${opts.hangTimeoutMs}ms after ${opts.bytesReceived} bytes (${opts.elapsedMs}ms elapsed)`,
      599,
      true, // always retryable
      opts.providerId,
      {
        body: {
          message: `Stream stalled after ${opts.elapsedMs}ms, ${opts.bytesReceived} bytes received`,
        },
        cause: opts.cause,
      },
    );
    this.name = 'StreamHangError';
    this.hungProviderId = opts.providerId;
    this.hungModel = opts.model;
    this.hangTimeoutMs = opts.hangTimeoutMs;
    this.bytesReceived = opts.bytesReceived;
    this.elapsedMs = opts.elapsedMs;
  }
}

function providerStatusToCode(status: number, type?: string): ErrorCode {
  if (status === 0) return ERROR_CODES.PROVIDER_NETWORK_ERROR;
  if (type === 'rate_limit_error' || status === 429) return ERROR_CODES.PROVIDER_RATE_LIMITED;
  if (type === 'authentication_error' || status === 401) return ERROR_CODES.PROVIDER_AUTH_FAILED;
  if (type === 'overloaded_error' || status === 529) return ERROR_CODES.PROVIDER_OVERLOADED;
  if (type === 'invalid_request_error' || status === 400) return ERROR_CODES.PROVIDER_INVALID_REQUEST;
  if (status === 408) return ERROR_CODES.PROVIDER_NETWORK_ERROR;
  if (status >= 500) return ERROR_CODES.PROVIDER_SERVER_ERROR;
  return ERROR_CODES.PROVIDER_INVALID_REQUEST;
}
