/**
 * OpenAI provider as a declarative `WireFormatConfig`. Same canonical events
 * as `OpenAIProvider`; the per-message body is the loop body of
 * `parseOpenAIStream` split into a stateful step.
 */
import type { Capabilities, ReasoningEffort, Request, ResponseFormat, StopReason, StreamEvent, Usage } from '@wrongstack/core';
import { safeParse } from '@wrongstack/core';
import { parseToolInput } from '../_tool-input.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { normalizeOpenAI } from '../stop-reason.js';
import { messagesToOpenAI, toolsToOpenAI } from '../tool-format/to-openai.js';
import { defineWireFormat } from '../wire-format.js';
import { stripCacheControl } from '../object-utils.js';

export interface OpenAIStreamState {
  model: string;
  usage: Usage;
  stopReason: StopReason;
  started: boolean;
  textOpen: boolean;
  thinkingOpen: boolean;
  toolByIndex: Map<
    number,
    { id?: string | undefined; name?: string | undefined; argBuf: string; emittedStart: boolean; emittedArgLength: number }
  >;
  finalEmitted: boolean;
}

export const openaiWireFormat = defineWireFormat<OpenAIStreamState>({
  id: 'openai',
  family: 'openai',
  capabilities: capabilitiesForFamily('openai'),
  defaultBaseUrl: 'https://api.openai.com/v1',
  buildUrl: (base) => {
    const b = base.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(b)) return b;
    if (/\/v\d+(\/[a-z0-9_-]+)*$/i.test(b)) return `${b}/chat/completions`;
    return `${b}/v1/chat/completions`;
  },
  buildHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req: Request, ctx: { capabilities: Capabilities }) => {
    const maxOutput = req.maxTokens ?? ctx.capabilities.maxOutput ?? 8192;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToOpenAI(stripCacheControl(req.system), req.messages),
      // Real OpenAI requires `max_completion_tokens`; newer model families
      // (gpt-4o, o1/o3/o4) 400 on the deprecated `max_tokens`. See issue #10.
      max_completion_tokens: maxOutput,
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
  },
  createStreamState: (fallbackModel) => ({
    model: fallbackModel,
    usage: { input: 0, output: 0 },
    stopReason: 'end_turn',
    started: false,
    textOpen: false,
    thinkingOpen: false,
    toolByIndex: new Map(),
    finalEmitted: false,
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const obj = parsed.value;
    const out: StreamEvent[] = [];

    if (typeof obj['model'] === 'string') state.model = obj['model'] as string;
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
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

    // DeepSeek (and Moonshot/Kimi thinking mode, OpenRouter `reasoning`)
    // streams chain-of-thought as `delta.reasoning_content` at the top of
    // the delta. The full blob MUST be echoed back as message-level
    // `reasoning_content` on the next request — otherwise DeepSeek 400s.
    const reasoningDelta =
      typeof choice?.delta?.reasoning_content === 'string'
        ? choice.delta.reasoning_content
        : typeof choice?.delta?.reasoning === 'string'
          ? choice.delta.reasoning
          : undefined;
    if (reasoningDelta && reasoningDelta.length > 0) {
      if (!state.thinkingOpen) {
        state.thinkingOpen = true;
        out.push({ type: 'thinking_start' });
      }
      out.push({ type: 'thinking_delta', text: reasoningDelta });
    }

    if (choice?.delta?.content) {
      if (state.thinkingOpen) {
        state.thinkingOpen = false;
        out.push({ type: 'thinking_stop' });
      }
      if (!state.textOpen) state.textOpen = true;
      out.push({ type: 'text_delta', text: choice.delta.content });
    }

    if (choice?.delta?.tool_calls) {
      if (state.thinkingOpen) {
        state.thinkingOpen = false;
        out.push({ type: 'thinking_stop' });
      }
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = state.toolByIndex.get(idx);
        if (!entry) {
          entry = {
            id: tc.id,
            name: tc.function?.name,
            argBuf: '',
            emittedStart: false,
            emittedArgLength: 0,
          };
          state.toolByIndex.set(idx, entry);
        } else {
          if (tc.id && !entry.id) entry.id = tc.id;
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          entry.argBuf += tc.function.arguments;
        }
        if (!entry.emittedStart && entry.id && entry.name) {
          entry.emittedStart = true;
          state.textOpen = false;
          out.push({ type: 'tool_use_start', id: entry.id, name: entry.name });
        }
        if (entry.emittedStart && entry.id && entry.emittedArgLength < entry.argBuf.length) {
          const partial = entry.argBuf.slice(entry.emittedArgLength);
          entry.emittedArgLength = entry.argBuf.length;
          out.push({
            type: 'tool_use_input_delta',
            id: entry.id,
            partial,
          });
        }
      }
    }

    if (choice?.finish_reason) {
      state.stopReason = normalizeOpenAI(choice.finish_reason);
    }

    const u = obj['usage'] as
      | {
          prompt_tokens?: number | undefined;
          completion_tokens?: number | undefined;
          prompt_tokens_details?: { cached_tokens?: number | undefined };
          prompt_cache_hit_tokens?: number | undefined;
          prompt_cache_miss_tokens?: number | undefined;
        }
      | undefined;
    if (u) {
      // Mirror openai.ts: disjoint semantics: input is fresh-only,
      // cacheRead is the cached subset. Subtracting prevents the cost
      // calc / cache-hit-ratio from double-counting cached tokens.
      const hasDeepSeekCacheFields =
        u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined;
      const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
      const promptTotal =
        u.prompt_tokens ??
        (hasDeepSeekCacheFields
          ? (u.prompt_cache_hit_tokens ?? 0) + (u.prompt_cache_miss_tokens ?? 0)
          : state.usage.input + cached);
      state.usage = {
        input: u.prompt_cache_miss_tokens ?? Math.max(0, promptTotal - cached),
        output: u.completion_tokens ?? state.usage.output,
        cacheRead: cached || state.usage.cacheRead,
      };
    }

    return out;
  },
  finalizeStream: (state): StreamEvent[] => {
    if (state.finalEmitted) return [];
    state.finalEmitted = true;
    const out: StreamEvent[] = [];
    if (state.thinkingOpen) {
      state.thinkingOpen = false;
      out.push({ type: 'thinking_stop' });
    }
    for (const entry of state.toolByIndex.values()) {
      if (!entry.id || !entry.name) continue;
      if (!entry.emittedStart) {
        out.push({ type: 'tool_use_start', id: entry.id, name: entry.name });
      }
      const input = parseToolInput(entry.argBuf);
      out.push({ type: 'tool_use_stop', id: entry.id, input });
    }
    if (state.started) {
      out.push({ type: 'message_stop', stopReason: state.stopReason, usage: state.usage });
    }
    return out;
  },
});

/**
 * OpenAI's Chat Completions API accepts `reasoning_effort` only for these
 * values. Mirrors the same-named guard in ../openai.ts.
 */
const OPENAI_EFFORT_VALUES = new Set<ReasoningEffort>(['none', 'low', 'medium', 'high']);

function isOpenAIEffort(effort: ReasoningEffort): boolean {
  return OPENAI_EFFORT_VALUES.has(effort);
}

/**
 * Translate a canonical `ResponseFormat` to OpenAI's `response_format` body field.
 * Mirrors the same-named helper in ../openai.ts.
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
