import type {
  Capabilities,
  Message,
  Request,
  StopReason,
  StreamEvent,
  Usage,
} from '@wrongstack/core';
import { ProviderError, safeParse } from '@wrongstack/core';
import { parseToolInput } from './_tool-input.js';
import { parseProviderHttpError } from './error-parse.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { parseSSE } from './sse.js';
import { normalizeAnthropic } from './stop-reason.js';
import { toolsToAnthropic } from './tool-format/to-anthropic.js';
import { WireAdapter } from './wire-adapter.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
  beta?: string[];
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';

export class AnthropicProvider extends WireAdapter {
  override readonly id = 'anthropic';
  override readonly capabilities: Capabilities = capabilitiesForFamily('anthropic');

  private readonly opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    super(opts.apiKey, opts.baseUrl ?? DEFAULT_BASE, opts.fetchImpl);
    this.opts = opts;
  }

  protected override buildUrl(_req: Request): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    if (/\/v\d+\/messages$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {
      ...super.buildHeaders(req),
      'x-api-key': this.apiKey,
      'anthropic-version': this.opts.apiVersion ?? DEFAULT_VERSION,
    };
    if (this.opts.beta && this.opts.beta.length > 0) {
      headers['anthropic-beta'] = this.opts.beta.join(',');
    }
    return headers;
  }

  protected override buildBody(req: Request): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: req.messages.map((m) => this.normalizeMessage(m)),
      stream: true,
    };
    if (req.system && req.system.length > 0) body['system'] = req.system;
    if (req.tools && req.tools.length > 0) body['tools'] = toolsToAnthropic(req.tools);
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.stopSequences) body['stop_sequences'] = req.stopSequences;
    if (req.toolChoice) body['tool_choice'] = req.toolChoice;
    return body;
  }

  protected override parseStream(
    body: Parameters<typeof parseSSE>[0],
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return parseAnthropicStream(body, fallbackModel);
  }

  protected override translateError(status: number, text: string): ProviderError {
    return parseProviderHttpError(this.id, status, text);
  }

  private normalizeMessage(m: Message): Record<string, unknown> {
    return {
      role: m.role === 'system' ? 'user' : m.role,
      content: typeof m.content === 'string' ? m.content : m.content,
    };
  }
}

type Response2Body = ReadableStream<Uint8Array> | NodeJS.ReadableStream | null;

/**
 * Translate Anthropic's SSE wire format into canonical StreamEvent[].
 *
 * Block indices ↔ canonical event ids:
 *   - text blocks emit text_delta with no id
 *   - tool_use blocks: content_block_start carries the toolu_xxx id, and
 *     subsequent input_json_delta chunks accumulate the JSON arg string.
 *
 * usage.input_tokens arrives in message_start; output_tokens lands in
 * message_delta.usage.
 */
async function* parseAnthropicStream(
  body: Response2Body,
  fallbackModel: string,
): AsyncIterable<StreamEvent> {
  type BlockKind = 'text' | 'tool_use' | 'thinking' | 'unknown';
  const blocks = new Map<
    number,
    { kind: BlockKind; id?: string; name?: string; partial: string }
  >();
  let model = fallbackModel;
  let usage: Usage = { input: 0, output: 0 };
  let stopReason: StopReason = 'end_turn';
  let started = false;
  let stopped = false;

  for await (const msg of parseSSE(body)) {
    if (!msg.data || msg.data === '[DONE]') continue;
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) continue;
    const ev = parsed.value;
    const type = String(ev['type'] ?? msg.event);

    switch (type) {
      case 'message_start': {
        const message = ev['message'] as
          | {
              model?: string;
              usage?: {
                input_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            }
          | undefined;
        if (message?.model) model = message.model;
        usage = {
          input: message?.usage?.input_tokens ?? 0,
          output: 0,
          cacheRead: message?.usage?.cache_read_input_tokens,
          cacheWrite: message?.usage?.cache_creation_input_tokens,
        };
        if (!started) {
          started = true;
          yield { type: 'message_start', model };
        }
        break;
      }
      case 'content_block_start': {
        const index = Number(ev['index'] ?? 0);
        const cb = ev['content_block'] as { type?: string; id?: string; name?: string } | undefined;
        if (cb?.type === 'tool_use') {
          blocks.set(index, { kind: 'tool_use', id: cb.id, name: cb.name, partial: '' });
          if (cb.id && cb.name) {
            yield { type: 'tool_use_start', id: cb.id, name: cb.name };
          }
        } else if (cb?.type === 'text') {
          blocks.set(index, { kind: 'text', partial: '' });
        } else if (cb?.type === 'thinking' || cb?.type === 'redacted_thinking') {
          // Anthropic extended thinking. The model emits an opening
          // `content_block_start` with type `thinking` (or
          // `redacted_thinking` when content was hidden from us), then
          // streams `thinking_delta` and a single `signature_delta`.
          // Both the text AND the signature must round-trip to the next
          // request — without the signature Anthropic returns 400.
          blocks.set(index, { kind: 'thinking', partial: '' });
          yield { type: 'thinking_start' };
        } else {
          blocks.set(index, { kind: 'unknown', partial: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const index = Number(ev['index'] ?? 0);
        const delta = ev['delta'] as
          | {
              type?: string;
              text?: string;
              partial_json?: string;
              thinking?: string;
              signature?: string;
              data?: string;
            }
          | undefined;
        const block = blocks.get(index);
        if (!block || !delta) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text_delta', text: delta.text };
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (block.id) {
            block.partial += delta.partial_json;
            yield { type: 'tool_use_input_delta', id: block.id, partial: delta.partial_json };
          }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'thinking_delta', text: delta.thinking };
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          yield { type: 'thinking_signature', signature: delta.signature };
        }
        break;
      }
      case 'content_block_stop': {
        const index = Number(ev['index'] ?? 0);
        const block = blocks.get(index);
        if (block?.kind === 'tool_use' && block.id) {
          const input = parseToolInput(block.partial);
          yield { type: 'tool_use_stop', id: block.id, input };
        } else if (block?.kind === 'thinking') {
          yield { type: 'thinking_stop' };
        }
        break;
      }
      case 'message_delta': {
        const delta = ev['delta'] as { stop_reason?: string | null } | undefined;
        const u = ev['usage'] as { output_tokens?: number } | undefined;
        if (delta?.stop_reason !== undefined) {
          stopReason = normalizeAnthropic(delta.stop_reason);
        }
        if (u?.output_tokens !== undefined) usage = { ...usage, output: u.output_tokens };
        break;
      }
      case 'message_stop':
        stopped = true;
        yield { type: 'message_stop', stopReason, usage };
        break;
      case 'error': {
        const err = ev['error'] as { message?: string; type?: string } | undefined;
        throw new ProviderError(err?.message ?? 'Anthropic stream error', 0, false, 'anthropic', {
          body: { type: err?.type, message: err?.message },
        });
      }
    }
  }
  if (started && !stopped) {
    yield { type: 'message_stop', stopReason, usage };
  }
}
