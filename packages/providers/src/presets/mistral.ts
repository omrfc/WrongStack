/**
 * Mistral provider as a declarative wire-format config — a 50-line proof
 * that adding a new OpenAI-flavored provider doesn't require subclassing.
 *
 * Mistral's streaming chat completion API is OpenAI-compatible at the wire
 * level, with `delta.content` + `delta.tool_calls` + `[DONE]` terminator.
 * For exotic providers the same pattern still applies — only the
 * `parseStreamEvent` body changes.
 */
import type { Capabilities, Request, StopReason, StreamEvent } from '@wrongstack/core';
import { safeParse } from '@wrongstack/core';
import { parseToolInput } from '../_tool-input.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { messagesToOpenAI, toolsToOpenAI } from '../tool-format/to-openai.js';
import { defineWireFormat } from '../wire-format.js';
import { stripCacheControl } from '../object-utils.js';

interface MistralStreamState {
  model: string;
  started: boolean;
  // OpenAI-style tool_call accumulators keyed by `index`
  toolCalls: Map<
    number,
    { id?: string | undefined; name?: string | undefined; partial: string; emittedStart: boolean; emittedArgLength: number }
  >;
}

export const mistralWireFormat = defineWireFormat<MistralStreamState>({
  id: 'mistral',
  family: 'openai-compatible',
  capabilities: capabilitiesForFamily('openai-compatible', {
    jsonMode: true,
    maxContext: 128_000,
  }),
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  buildUrl: (base) => `${base.replace(/\/+$/, '')}/chat/completions`,
  buildHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req: Request, ctx: { capabilities: Capabilities }) => {
    const maxOutput = req.maxTokens ?? ctx.capabilities.maxOutput ?? 8192;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToOpenAI(stripCacheControl(req.system), req.messages),
      max_tokens: maxOutput,
      stream: true,
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
    if (req.topK !== undefined) body['top_k'] = req.topK;
    if (req.frequencyPenalty !== undefined) body['frequency_penalty'] = req.frequencyPenalty;
    if (req.presencePenalty !== undefined) body['presence_penalty'] = req.presencePenalty;
    if (req.seed !== undefined) body['seed'] = req.seed;
    if (req.stopSequences) body['stop'] = req.stopSequences;
    return body;
  },
  createStreamState: (fallbackModel) => ({
    model: fallbackModel,
    started: false,
    toolCalls: new Map(),
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    const parsed = safeParse<{
      model?: string | undefined;
      choices?: {
        delta?: {
          content?: string | undefined;
          tool_calls?: {
            index: number;
            id?: string | undefined;
            function?: { name?: string | undefined; arguments?: string | undefined };
          }[];
        };
        finish_reason?: string | undefined;
      }[];
      usage?: { prompt_tokens?: number | undefined; completion_tokens?: number | undefined };
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
        block = {
          id: tc.id,
          name: tc.function?.name,
          partial: '',
          emittedStart: false,
          emittedArgLength: 0,
        };
        state.toolCalls.set(tc.index, block);
      } else {
        if (tc.id && !block.id) block.id = tc.id;
        if (tc.function?.name && !block.name) block.name = tc.function.name;
      }
      const arg = tc.function?.arguments;
      if (arg) {
        block.partial += arg;
      }
      if (!block.emittedStart && block.id && block.name) {
        block.emittedStart = true;
        out.push({ type: 'tool_use_start', id: block.id, name: block.name });
      }
      if (block.emittedStart && block.id && block.emittedArgLength < block.partial.length) {
        const partial = block.partial.slice(block.emittedArgLength);
        block.emittedArgLength = block.partial.length;
        out.push({ type: 'tool_use_input_delta', id: block.id, partial });
      }
    }
    if (choice?.finish_reason) {
      // Close out tool calls with parsed JSON
      for (const block of state.toolCalls.values()) {
        if (block.id && block.name) {
          if (!block.emittedStart) {
            out.push({ type: 'tool_use_start', id: block.id, name: block.name });
          }
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
    case 'tool_calls':
      return 'tool_use';
    case 'length':
    case 'model_length':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}
