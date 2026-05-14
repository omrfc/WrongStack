import { ProviderError } from '@wrongstack/core';
import type { ProviderErrorBody } from '@wrongstack/core';

/**
 * Provider HTTP error bodies come in three or four shapes depending on
 * vendor. Rather than dump the raw JSON into the error message (which is
 * what was shipped to the user log before this module existed), we parse
 * out the fields we care about — `type`, `message`, `requestId` — and put
 * them on `ProviderError.body` for `describe()` and downstream rendering.
 *
 * The function is intentionally tolerant: anything we can't parse falls
 * back to a truncated raw string, never throws.
 */
export function parseProviderHttpError(
  providerId: string,
  status: number,
  rawText: string,
): ProviderError {
  const body = parseBody(rawText);
  const retryable = isRetryable(status, body.type);
  const message = `${providerId} HTTP ${status}`;
  return new ProviderError(message, status, retryable, providerId, { body });
}

const RAW_TRUNCATE_AT = 2000;

function parseBody(rawText: string): ProviderErrorBody {
  const raw = rawText.slice(0, RAW_TRUNCATE_AT);
  // Surface truncation so downstream renderers (CLI error formatter, log
  // exporter) can show a "(truncated, N more bytes)" suffix instead of
  // silently dropping the rest of the provider's error tail.
  const body: ProviderErrorBody =
    rawText.length > RAW_TRUNCATE_AT
      ? { raw, truncated: true, rawLength: rawText.length }
      : { raw };
  if (!rawText.trim()) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;

  // Anthropic / MiniMax / Kimi: { type: "error", error: { type, message }, request_id }
  // OpenAI / OpenAI-compatible: { error: { message, type, code, param } }
  // Google: { error: { code, message, status } }
  const errField = parsed['error'];
  if (isRecord(errField)) {
    const t = stringOf(errField['type']) ?? stringOf(errField['status']);
    const m = stringOf(errField['message']);
    if (t) body.type = t;
    if (m) body.message = m;
  } else if (typeof errField === 'string') {
    body.message = errField;
  }
  // Top-level fields some providers use directly
  if (!body.type) {
    const t = stringOf(parsed['type']);
    if (t && t !== 'error') body.type = t;
  }
  if (!body.message) {
    const m = stringOf(parsed['message']);
    if (m) body.message = m;
  }

  // request_id (Anthropic), id (some compatible providers)
  const reqId =
    stringOf(parsed['request_id']) ??
    stringOf(parsed['requestId']) ??
    stringOf(parsed['id']);
  if (reqId) body.requestId = reqId;

  return body;
}

/**
 * Retryability is mostly driven by HTTP status, but provider-specific
 * `type` strings let us catch retryable conditions that don't have a
 * dedicated status code (e.g. Anthropic's `overloaded_error` is 529 but
 * we also retry it when wrapped in a 503).
 */
function isRetryable(status: number, type?: string): boolean {
  if (status === 0) return true; // network error
  if (status === 408 || status === 429 || status === 529) return true;
  if (status >= 500 && status < 600) return true;
  if (type === 'overloaded_error' || type === 'rate_limit_error') return true;
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
