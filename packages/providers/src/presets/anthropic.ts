/**
 * Anthropic provider expressed as a declarative `WireFormatConfig`.
 *
 * The existing `AnthropicProvider` class stays as the production path until
 * the rest of the registry switches over — both produce the same canonical
 * StreamEvent[]. The per-message logic here is extracted verbatim from
 * `parseAnthropicStream` in `../anthropic.ts`, just split into a stateful
 * `parseStreamEvent` call instead of an async generator loop.
 */
import type { Message, Request, StreamEvent, StopReason, Usage } from '@wrongstack/core';
import { ProviderError, safeParse } from '@wrongstack/core';
import { parseToolInput } from '../_tool-input.js';
import { toolsToAnthropic } from '../tool-format/to-anthropic.js';
import { normalizeAnthropic } from '../stop-reason.js';
import { defineWireFormat } from '../wire-format.js';

type BlockKind = 'text' | 'tool_use' | 'unknown';

interface AnthropicStreamState {
  model: string;
  usage: Usage;
  stopReason: StopReason;
  started: boolean;
  blocks: Map<number, { kind: BlockKind; id?: string; name?: string; partial: string }>;
}

const DEFAULT_VERSION = '2023-06-01';

export const anthropicWireFormat = defineWireFormat<AnthropicStreamState>({
  id: 'anthropic',
  family: 'anthropic',
  capabilities: {
    tools: true,
    parallelTools: true,
    vision: true,
    streaming: true,
    promptCache: true,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 200_000,
    cacheControl: 'native',
  },
  defaultBaseUrl: 'https://api.anthropic.com',
  buildUrl: (base) => {
    const b = base.replace(/\/+$/, '');
    if (/\/v\d+\/messages$/.test(b)) return b;
    if (/\/v\d+$/.test(b)) return `${b}/messages`;
    return `${b}/v1/messages`;
  },
  buildHeaders: (apiKey) => ({
    'x-api-key': apiKey,
    'anthropic-version': DEFAULT_VERSION,
  }),
  buildBody: (req: Request) => {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: req.messages.map((m: Message) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
      stream: true,
    };
    if (req.system && req.system.length > 0) body['system'] = req.system;
    if (req.tools && req.tools.length > 0) body['tools'] = toolsToAnthropic(req.tools);
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.stopSequences) body['stop_sequences'] = req.stopSequences;
    if (req.toolChoice) body['tool_choice'] = req.toolChoice;
    return body;
  },
  createStreamState: (fallbackModel) => ({
    model: fallbackModel,
    usage: { input: 0, output: 0 },
    stopReason: 'end_turn',
    started: false,
    blocks: new Map(),
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const ev = parsed.value;
    const type = String(ev['type'] ?? msg.event);
    const out: StreamEvent[] = [];

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
        if (message?.model) state.model = message.model;
        state.usage = {
          input: message?.usage?.input_tokens ?? 0,
          output: 0,
          cacheRead: message?.usage?.cache_read_input_tokens,
          cacheWrite: message?.usage?.cache_creation_input_tokens,
        };
        if (!state.started) {
          state.started = true;
          out.push({ type: 'message_start', model: state.model });
        }
        break;
      }
      case 'content_block_start': {
        const index = Number(ev['index'] ?? 0);
        const cb = ev['content_block'] as { type?: string; id?: string; name?: string } | undefined;
        if (cb?.type === 'tool_use') {
          state.blocks.set(index, { kind: 'tool_use', id: cb.id, name: cb.name, partial: '' });
          if (cb.id && cb.name) {
            out.push({ type: 'tool_use_start', id: cb.id, name: cb.name });
          }
        } else if (cb?.type === 'text') {
          state.blocks.set(index, { kind: 'text', partial: '' });
        } else {
          state.blocks.set(index, { kind: 'unknown', partial: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const index = Number(ev['index'] ?? 0);
        const delta = ev['delta'] as
          | { type?: string; text?: string; partial_json?: string }
          | undefined;
        const block = state.blocks.get(index);
        if (!block || !delta) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          out.push({ type: 'text_delta', text: delta.text });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (block.id) {
            block.partial += delta.partial_json;
            out.push({ type: 'tool_use_input_delta', id: block.id, partial: delta.partial_json });
          }
        }
        break;
      }
      case 'content_block_stop': {
        const index = Number(ev['index'] ?? 0);
        const block = state.blocks.get(index);
        if (block?.kind === 'tool_use' && block.id) {
          const input = parseToolInput(block.partial);
          out.push({ type: 'tool_use_stop', id: block.id, input });
        }
        break;
      }
      case 'message_delta': {
        const delta = ev['delta'] as { stop_reason?: string | null } | undefined;
        const u = ev['usage'] as { output_tokens?: number } | undefined;
        if (delta?.stop_reason !== undefined) {
          state.stopReason = normalizeAnthropic(delta.stop_reason);
        }
        if (u?.output_tokens !== undefined) {
          state.usage = { ...state.usage, output: u.output_tokens };
        }
        break;
      }
      case 'message_stop':
        out.push({ type: 'message_stop', stopReason: state.stopReason, usage: state.usage });
        break;
      case 'error': {
        const err = ev['error'] as { message?: string; type?: string } | undefined;
        throw new ProviderError(
          err?.message ?? 'Anthropic stream error',
          0,
          false,
          'anthropic',
          { body: { type: err?.type, message: err?.message } },
        );
      }
    }
    return out;
  },
  finalizeStream: (state): StreamEvent[] => {
    // If upstream closed without an explicit `message_stop` we synthesize
    // one so the consumer's stream-end logic still fires.
    if (state.started) {
      return [{ type: 'message_stop', stopReason: state.stopReason, usage: state.usage }];
    }
    return [];
  },
});
