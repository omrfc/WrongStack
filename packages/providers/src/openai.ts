import type {
  Capabilities,
  Request,
  StreamEvent,
  StopReason,
  Usage,
} from '@wrongstack/core';
import { ProviderError, safeParse } from '@wrongstack/core';
import { parseProviderHttpError } from './error-parse.js';
import {
  messagesToOpenAI,
  toolsToOpenAI,
  type ConvertOptions,
} from './tool-format/to-openai.js';
import { normalizeOpenAI } from './stop-reason.js';
import { parseSSE } from './sse.js';
import { WireAdapter } from './wire-adapter.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  fetchImpl?: typeof fetch;
  quirks?: ConvertOptions & {
    parallelToolsDisabled?: boolean;
    jsonArgumentsBuggy?: boolean;
  };
  id?: string;
  capabilities?: Partial<Capabilities>;
}

const DEFAULT_BASE = 'https://api.openai.com/v1';

export class OpenAIProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  protected readonly opts: OpenAIProviderOptions;

  constructor(opts: OpenAIProviderOptions) {
    super(opts.apiKey, opts.baseUrl ?? DEFAULT_BASE, opts.fetchImpl);
    this.opts = opts;
    this.id = opts.id ?? 'openai';
    this.capabilities = {
      tools: true,
      parallelTools: !opts.quirks?.parallelToolsDisabled,
      vision: true,
      streaming: true,
      promptCache: false,
      systemPrompt: !opts.quirks?.systemAsMessage,
      jsonMode: true,
      maxContext: 128_000,
      cacheControl: 'auto',
      ...opts.capabilities,
    };
  }

  protected override buildUrl(_req: Request): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v\d+(\/[a-z0-9_-]+)*$/i.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {
      ...super.buildHeaders(req),
      authorization: `Bearer ${this.apiKey}`,
    };
    if (this.opts.organization) {
      headers['openai-organization'] = this.opts.organization;
    }
    return headers;
  }

  protected override buildBody(req: Request): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToOpenAI(this.stripCacheControl(req), req.messages, {
        ...this.opts.quirks,
      }),
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools && req.tools.length > 0) {
      body['tools'] = toolsToOpenAI(req.tools);
      if (req.toolChoice) {
        if (typeof req.toolChoice === 'string') {
          body['tool_choice'] = req.toolChoice === 'required' ? 'required' : req.toolChoice;
        } else {
          body['tool_choice'] = {
            type: 'function',
            function: { name: req.toolChoice.name },
          };
        }
      }
    }
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.stopSequences) body['stop'] = req.stopSequences;
    return body;
  }

  protected override parseStream(
    body: Parameters<typeof parseSSE>[0],
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return parseOpenAIStream(body, fallbackModel);
  }

  protected override translateError(status: number, text: string): ProviderError {
    return parseProviderHttpError(this.id, status, text);
  }

  private stripCacheControl(req: Request): typeof req.system {
    if (!req.system) return undefined;
    return req.system.map((b) => {
      // Omit cache_control without mutating a copy — rest spread is cleaner.
      const { cache_control: _cc, ...rest } = b;
      return rest;
    });
  }
}

type Response2Body = ReadableStream<Uint8Array> | NodeJS.ReadableStream | null;

/**
 * Translate an OpenAI /chat/completions SSE stream into canonical StreamEvent[].
 *
 * Wire format per chunk:
 *   data: {"id":"...","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}
 *   data: {"id":"...","choices":[{"index":0,"delta":{"tool_calls":[
 *           {"index":0,"id":"call_x","function":{"name":"echo","arguments":"{\"text\":"}}]},"finish_reason":null}]}
 *   data: {"id":"...","choices":[{...,"finish_reason":"stop"}],"usage":{"prompt_tokens":12,...}}
 *   data: [DONE]
 *
 * Tool calls stream as a sequence of partial fragments keyed by their
 * `index` in the delta array; we map index → canonical tool_use id from
 * the first chunk that carries one.
 */
async function* parseOpenAIStream(
  body: Response2Body,
  fallbackModel: string,
): AsyncIterable<StreamEvent> {
  let model = fallbackModel;
  let usage: Usage = { input: 0, output: 0 };
  let stopReason: StopReason = 'end_turn';
  let started = false;
  let textOpen = false;
  const toolByIndex = new Map<number, { id: string; name: string; argBuf: string }>();

  for await (const msg of parseSSE(body)) {
    if (!msg.data || msg.data === '[DONE]') continue;
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) continue;
    const obj = parsed.value;

    if (typeof obj['model'] === 'string') model = obj['model'];
    if (!started) {
      started = true;
      yield { type: 'message_start', model };
    }

    const choices = obj['choices'] as Array<{
      delta?: {
        content?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }> | undefined;
    const choice = choices?.[0];

    if (choice?.delta?.content) {
      if (!textOpen) textOpen = true;
      yield { type: 'text_delta', text: choice.delta.content };
    }

    if (choice?.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolByIndex.get(idx);
        if (!entry && tc.id && tc.function?.name) {
          entry = { id: tc.id, name: tc.function.name, argBuf: '' };
          toolByIndex.set(idx, entry);
          textOpen = false;
          yield { type: 'tool_use_start', id: entry.id, name: entry.name };
        }
        if (entry && tc.function?.arguments) {
          entry.argBuf += tc.function.arguments;
          yield {
            type: 'tool_use_input_delta',
            id: entry.id,
            partial: tc.function.arguments,
          };
        }
      }
    }

    if (choice?.finish_reason) {
      stopReason = normalizeOpenAI(choice.finish_reason);
    }

    const u = obj['usage'] as
      | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
      | undefined;
    if (u) {
      usage = {
        input: u.prompt_tokens ?? usage.input,
        output: u.completion_tokens ?? usage.output,
        cacheRead: u.prompt_tokens_details?.cached_tokens ?? usage.cacheRead,
      };
    }
  }

  for (const entry of toolByIndex.values()) {
    const input = entry.argBuf
      ? (safeParse<unknown>(entry.argBuf).value ?? { _raw: entry.argBuf })
      : {};
    yield { type: 'tool_use_stop', id: entry.id, input };
  }
  if (started) {
    yield { type: 'message_stop', stopReason, usage };
  }
}