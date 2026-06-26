import { randomUUID } from 'node:crypto';
import type { Capabilities, ReasoningEffort, Request, ResponseFormat, StopReason, StreamEvent, Usage } from '@wrongstack/core';
import { type ProviderError, safeParse } from '@wrongstack/core';
import { parseToolInput } from './_tool-input.js';
import { parseProviderHttpError } from './error-parse.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { parseSSE } from './sse.js';
import { normalizeOpenAI } from './stop-reason.js';
import { type ConvertOptions, messagesToOpenAI, toolsToOpenAI } from './tool-format/to-openai.js';
import { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  quirks?: ConvertOptions & {
    parallelToolsDisabled?: boolean | undefined;
    jsonArgumentsBuggy?: boolean | undefined;
    thinkingParam?: 'zai-glm' | 'kimi-toggle' | 'always-on' | undefined;
  } | undefined;
  id?: string | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  /** Raw stream debugging and hang-detection options. */
  streamOpts?: WireAdapterStreamOptions | undefined;
}

const DEFAULT_BASE = 'https://api.openai.com/v1';

export class OpenAIProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  protected readonly opts: OpenAIProviderOptions;

  constructor(opts: OpenAIProviderOptions) {
    super(opts.apiKey, opts.baseUrl ?? DEFAULT_BASE, opts.fetchImpl, opts.streamOpts);
    this.opts = opts;
    this.id = opts.id ?? 'openai';
    this.capabilities = capabilitiesForFamily('openai', {
      parallelTools: !opts.quirks?.parallelToolsDisabled,
      systemPrompt: !opts.quirks?.systemAsMessage,
      ...opts.capabilities,
    });
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

  /**
   * The request field used to cap output length. Real OpenAI deprecated
   * `max_tokens` and the newer model families (gpt-4o, o1/o3/o4) 400 on it —
   * they require `max_completion_tokens`. OpenAI-compatible endpoints that
   * still only accept `max_tokens` override this. See issue #10.
   */
  protected tokenLimitParam(): string {
    return 'max_completion_tokens';
  }

  protected override buildBody(
    req: Request,
    ctx: { capabilities: Capabilities },
  ): Record<string, unknown> {
    const maxOutput = req.maxTokens ?? ctx.capabilities.maxOutput ?? 8192;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToOpenAI(this.stripCacheControl(req), req.messages, {
        ...this.opts.quirks,
      }),
      [this.tokenLimitParam()]: maxOutput,
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
    if (req.frequencyPenalty !== undefined) body['frequency_penalty'] = req.frequencyPenalty;
    if (req.presencePenalty !== undefined) body['presence_penalty'] = req.presencePenalty;
    if (req.seed !== undefined) body['seed'] = req.seed;
    if (req.user) body['user'] = req.user;
    if (req.logprobs === true) {
      body['logprobs'] = true;
      if (req.topLogprobs !== undefined) body['top_logprobs'] = req.topLogprobs;
    }
    if (req.stopSequences) body['stop'] = req.stopSequences;
    if (req.reasoning?.effort !== undefined && isOpenAIEffort(req.reasoning.effort)) {
      body['reasoning_effort'] = req.reasoning.effort;
    }
    if (req.responseFormat) {
      body['response_format'] = responseFormatToOpenAI(req.responseFormat);
    }
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

/**
 * OpenAI's Chat Completions API accepts `reasoning_effort` only for these
 * values. `minimal`, `xhigh`, and `max` are broader WrongStack-internal
 * effort levels that get mapped down or filtered out here — sending an
 * unrecognized `reasoning_effort` would cause a 400.
 */
const OPENAI_EFFORT_VALUES = new Set<ReasoningEffort>(['none', 'low', 'medium', 'high']);

function isOpenAIEffort(effort: ReasoningEffort): boolean {
  return OPENAI_EFFORT_VALUES.has(effort);
}

/**
 * Translate a canonical `ResponseFormat` to OpenAI's `response_format` body field.
 *
 *   text        → { type: 'text' }
 *   json_object → { type: 'json_object' }
 *   json_schema → { type: 'json_schema', json_schema: { name, strict, schema } }
 */
function responseFormatToOpenAI(fmt: ResponseFormat): Record<string, unknown> {
  if (fmt.type === 'text') return { type: 'text' };
  if (fmt.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: fmt.jsonSchema.name,
      strict: fmt.jsonSchema.strict ?? true,
      schema: fmt.jsonSchema.schema,
      ...(fmt.jsonSchema.description ? { description: fmt.jsonSchema.description } : {}),
    },
  };
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
  let thinkingOpen = false;
  const toolByIndex = new Map<
    number,
    { id?: string | undefined; name?: string | undefined; argBuf: string; emittedStart: boolean; emittedArgLength: number }
  >();

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

    const choices = obj['choices'] as
      | Array<{
          delta?: {
            content?: string | null | undefined;
            reasoning_content?: string | undefined;
            reasoning?: string | undefined;
            tool_calls?: Array<{
              index?: number | undefined;
              id?: string | undefined;
              function?: { name?: string | undefined; arguments?: string | undefined };
            }>;
          };
          finish_reason?: string | null | undefined;
        }>
      | undefined;
    const choice = choices?.[0];

    // DeepSeek (and Moonshot/Kimi thinking mode) stream chain-of-thought
    // as `delta.reasoning_content` at the top of the delta. The full blob
    // MUST be echoed back as message-level `reasoning_content` on the
    // next request — otherwise DeepSeek 400s with "reasoning_content in
    // the thinking mode must be passed back to the API".
    // OpenRouter sometimes uses `delta.reasoning` for the same field.
    const reasoningDelta =
      typeof choice?.delta?.reasoning_content === 'string'
        ? choice.delta.reasoning_content
        : typeof choice?.delta?.reasoning === 'string'
          ? choice.delta.reasoning
          : undefined;
    if (reasoningDelta && reasoningDelta.length > 0) {
      if (!thinkingOpen) {
        thinkingOpen = true;
        yield { type: 'thinking_start' };
      }
      yield { type: 'thinking_delta', text: reasoningDelta };
    }

    if (choice?.delta?.content) {
      if (thinkingOpen) {
        thinkingOpen = false;
        yield { type: 'thinking_stop' };
      }
      if (!textOpen) textOpen = true;
      yield { type: 'text_delta', text: choice.delta.content };
    }

    if (choice?.delta?.tool_calls) {
      if (thinkingOpen) {
        thinkingOpen = false;
        yield { type: 'thinking_stop' };
      }
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolByIndex.get(idx);
        if (!entry) {
          entry = {
            id: tc.id,
            name: tc.function?.name,
            argBuf: '',
            emittedStart: false,
            emittedArgLength: 0,
          };
          toolByIndex.set(idx, entry);
        } else {
          if (tc.id && !entry.id) entry.id = tc.id;
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          entry.argBuf += tc.function.arguments;
        }
        if (!entry.emittedStart && entry.id && entry.name) {
          entry.emittedStart = true;
          textOpen = false;
          yield { type: 'tool_use_start', id: entry.id, name: entry.name };
        }
        if (entry.emittedStart && entry.id && entry.emittedArgLength < entry.argBuf.length) {
          const partial = entry.argBuf.slice(entry.emittedArgLength);
          entry.emittedArgLength = entry.argBuf.length;
          yield {
            type: 'tool_use_input_delta',
            id: entry.id,
            partial,
          };
        }
      }
    }

    if (choice?.finish_reason) {
      stopReason = normalizeOpenAI(choice.finish_reason);
    }

    const u = obj['usage'] as
      | {
          prompt_tokens?: number | undefined;
          input_tokens?: number | undefined;
          completion_tokens?: number | undefined;
          prompt_tokens_details?: { cached_tokens?: number | undefined };
          prompt_cache_hit_tokens?: number | undefined;
          prompt_cache_miss_tokens?: number | undefined;
        }
      | undefined;
    if (u) {
      // Normalize to disjoint semantics: `input` is fresh-only (priced at
      // the full rate), `cacheRead` is the cached subset (priced at the
      // cache rate). OpenAI returns `prompt_tokens_details.cached_tokens`;
      // DeepSeek returns `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`.
      const hasDeepSeekCacheFields =
        u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined;
      const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
      const promptTotal =
        u.prompt_tokens ?? u.input_tokens ??
        (hasDeepSeekCacheFields
          ? (u.prompt_cache_hit_tokens ?? 0) + (u.prompt_cache_miss_tokens ?? 0)
          : usage.input + cached);
      usage = {
        input: u.prompt_cache_miss_tokens ?? Math.max(0, promptTotal - cached),
        output: u.completion_tokens ?? usage.output,
        cacheRead: cached || usage.cacheRead,
      };
    }
  }

  if (thinkingOpen) {
    yield { type: 'thinking_stop' };
  }
  for (const entry of toolByIndex.values()) {
    // A tool call with no name is unusable — there's nothing to dispatch to.
    if (!entry.name) continue;
    // Some OpenAI-compatible servers (proxies, local runtimes) omit the
    // `id` field on streamed tool calls entirely. Dropping the call here
    // would silently swallow the model's action; synthesize a stable id so
    // it still dispatches and correlates with its tool_result. Mirrors the
    // Google adapter, which always assigns an id.
    if (!entry.id) entry.id = `call_${randomUUID()}`;
    if (!entry.emittedStart) {
      yield { type: 'tool_use_start', id: entry.id, name: entry.name };
    }
    const input = parseToolInput(entry.argBuf);
    yield { type: 'tool_use_stop', id: entry.id, input };
  }
  if (started) {
    yield { type: 'message_stop', stopReason, usage };
  }
}
