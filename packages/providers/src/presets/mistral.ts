/**
 * Mistral provider as a declarative wire-format config — a 50-line proof
 * that adding a new OpenAI-flavored provider doesn't require subclassing.
 *
 * Mistral's streaming chat completion API is OpenAI-compatible at the wire
 * level, with `delta.content` + `delta.tool_calls` + `[DONE]` terminator.
 * For exotic providers the same pattern still applies — only the
 * `parseStreamEvent` body changes.
 */
import type { Request, StreamEvent, StopReason } from '@wrongstack/core';
import { safeParse } from '@wrongstack/core';
import { parseToolInput } from '../_tool-input.js';
import { defineWireFormat } from '../wire-format.js';

interface MistralStreamState {
  model: string;
  started: boolean;
  // OpenAI-style tool_call accumulators keyed by `index`
  toolCalls: Map<number, { id?: string; name?: string; partial: string; emittedStart: boolean }>;
}

export const mistralWireFormat = defineWireFormat<MistralStreamState>({
  id: 'mistral',
  family: 'openai-compatible',
  capabilities: {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: true,
    promptCache: false,
    systemPrompt: true,
    jsonMode: true,
    maxContext: 128_000,
    cacheControl: 'none',
  },
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  buildUrl: (base) => `${base.replace(/\/+$/, '')}/chat/completions`,
  buildHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req: Request) => ({
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    top_p: req.topP,
    stop: req.stopSequences,
    stream: true,
    tools: req.tools,
  }),
  createStreamState: (fallbackModel) => ({
    model: fallbackModel,
    started: false,
    toolCalls: new Map(),
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    const parsed = safeParse<{
      model?: string;
      choices?: {
        delta?: {
          content?: string;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const ev = parsed.value;
    const out: StreamEvent[] = [];
    if (ev.model) state.model = ev.model;
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
    }
    const choice = ev.choices?.[0];
    if (choice?.delta?.content) {
      out.push({ type: 'text_delta', text: choice.delta.content });
    }
    for (const tc of choice?.delta?.tool_calls ?? []) {
      let block = state.toolCalls.get(tc.index);
      if (!block) {
        block = { id: tc.id, name: tc.function?.name, partial: '', emittedStart: false };
        state.toolCalls.set(tc.index, block);
      } else {
        if (tc.id && !block.id) block.id = tc.id;
        if (tc.function?.name && !block.name) block.name = tc.function.name;
      }
      if (!block.emittedStart && block.id && block.name) {
        block.emittedStart = true;
        out.push({ type: 'tool_use_start', id: block.id, name: block.name });
      }
      const arg = tc.function?.arguments;
      if (arg && block.id) {
        block.partial += arg;
        out.push({ type: 'tool_use_input_delta', id: block.id, partial: arg });
      }
    }
    if (choice?.finish_reason) {
      // Close out tool calls with parsed JSON
      for (const block of state.toolCalls.values()) {
        if (block.id) {
          out.push({
            type: 'tool_use_stop',
            id: block.id,
            input: parseToolInput(block.partial),
          });
        }
      }
      out.push({
        type: 'message_stop',
        stopReason: mapStopReason(choice.finish_reason),
        usage: {
          input: ev.usage?.prompt_tokens ?? 0,
          output: ev.usage?.completion_tokens ?? 0,
        },
      });
    }
    return out;
  },
});

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'stop_sequence';
    default: return 'end_turn';
  }
}
