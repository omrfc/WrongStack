/**
 * OpenAI provider as a declarative `WireFormatConfig`. Same canonical events
 * as `OpenAIProvider`; the per-message body is the loop body of
 * `parseOpenAIStream` split into a stateful step.
 */
import type { Request, StopReason, StreamEvent, Usage } from '@wrongstack/core';
import { safeParse } from '@wrongstack/core';
import { parseToolInput } from '../_tool-input.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { normalizeOpenAI } from '../stop-reason.js';
import { messagesToOpenAI, toolsToOpenAI } from '../tool-format/to-openai.js';
import { defineWireFormat } from '../wire-format.js';

interface OpenAIStreamState {
  model: string;
  usage: Usage;
  stopReason: StopReason;
  started: boolean;
  textOpen: boolean;
  thinkingOpen: boolean;
  toolByIndex: Map<number, { id: string; name: string; argBuf: string }>;
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
  buildBody: (req: Request) => {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToOpenAI(stripCacheControl(req.system), req.messages, {}),
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
            content?: string | null;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
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
        if (!entry && tc.id && tc.function?.name) {
          entry = { id: tc.id, name: tc.function.name, argBuf: '' };
          state.toolByIndex.set(idx, entry);
          state.textOpen = false;
          out.push({ type: 'tool_use_start', id: entry.id, name: entry.name });
        }
        if (entry && tc.function?.arguments) {
          entry.argBuf += tc.function.arguments;
          out.push({
            type: 'tool_use_input_delta',
            id: entry.id,
            partial: tc.function.arguments,
          });
        }
      }
    }

    if (choice?.finish_reason) {
      state.stopReason = normalizeOpenAI(choice.finish_reason);
    }

    const u = obj['usage'] as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        }
      | undefined;
    if (u) {
      // Mirror openai.ts: disjoint semantics — input is fresh-only,
      // cacheRead is the cached subset. Subtracting prevents the cost
      // calc / cache-hit-ratio from double-counting cached tokens.
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      const promptTotal = u.prompt_tokens ?? state.usage.input + cached;
      state.usage = {
        input: Math.max(0, promptTotal - cached),
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
      const input = parseToolInput(entry.argBuf);
      out.push({ type: 'tool_use_stop', id: entry.id, input });
    }
    if (state.started) {
      out.push({ type: 'message_stop', stopReason: state.stopReason, usage: state.usage });
    }
    return out;
  },
});

function stripCacheControl(system: Request['system']): Request['system'] {
  if (!system) return undefined;
  return system.map((b) => {
    const { cache_control: _cc, ...rest } = b;
    return rest;
  });
}
