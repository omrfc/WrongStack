import type {
  ContentBlock,
  Response,
  StopReason,
  StreamEvent,
  Usage,
} from '@wrongstack/core';
import { parseToolInput } from './_tool-input.js';

/**
 * Consume an `AsyncIterable<StreamEvent>` and reduce it to a non-streaming
 * `Response`. Used by `Provider.complete()` default impls so that the
 * streaming code path is the single source of truth.
 *
 * Optional `onEvent` callback fires for every event as it arrives, useful
 * for the agent loop to emit text_delta to the EventBus without writing
 * its own aggregation logic.
 */
export async function aggregateStream(
  stream: AsyncIterable<StreamEvent>,
  onEvent?: (e: StreamEvent) => void,
): Promise<Response> {
  let model = '';
  let stopReason: StopReason = 'end_turn';
  let usage: Usage = { input: 0, output: 0 };
  const textBuffers: string[] = [];
  let currentTextIndex = -1;
  const toolBuffers = new Map<string, { name: string; partial: string; input?: unknown }>();
  const blockOrder: Array<{ kind: 'text'; idx: number } | { kind: 'tool'; id: string }> = [];

  for await (const ev of stream) {
    if (onEvent) onEvent(ev);
    switch (ev.type) {
      case 'message_start':
        model = ev.model;
        break;
      case 'text_delta':
        if (currentTextIndex === -1) {
          currentTextIndex = textBuffers.length;
          textBuffers.push('');
          blockOrder.push({ kind: 'text', idx: currentTextIndex });
        }
        textBuffers[currentTextIndex] = (textBuffers[currentTextIndex] ?? '') + ev.text;
        break;
      case 'tool_use_start':
        // A tool_use block starts — close any open text block so subsequent
        // text_delta starts a new one.
        currentTextIndex = -1;
        toolBuffers.set(ev.id, { name: ev.name, partial: '' });
        blockOrder.push({ kind: 'tool', id: ev.id });
        break;
      case 'tool_use_input_delta': {
        const b = toolBuffers.get(ev.id);
        if (b) b.partial += ev.partial;
        break;
      }
      case 'tool_use_stop': {
        const b = toolBuffers.get(ev.id);
        if (b) {
          if (ev.input === undefined) {
            // No upstream input — parse from the accumulated partial buffer.
            b.input = parseToolInput(b.partial);
          } else if (typeof ev.input === 'string') {
            // Upstream gave us a raw JSON string; route through the validator.
            b.input = parseToolInput(ev.input);
          } else if (ev.input && typeof ev.input === 'object' && !Array.isArray(ev.input)) {
            b.input = ev.input;
          } else {
            // Array / scalar — preserve via __raw so downstream sees an object.
            b.input = { __raw: ev.input };
          }
        }
        // Tool just stopped — next text_delta should open a new text block.
        currentTextIndex = -1;
        break;
      }
      case 'message_stop':
        stopReason = ev.stopReason;
        usage = ev.usage;
        break;
    }
  }

  const content: ContentBlock[] = [];
  for (const b of blockOrder) {
    if (b.kind === 'text') {
      const text = textBuffers[b.idx] ?? '';
      if (text) content.push({ type: 'text', text });
    } else {
      const tb = toolBuffers.get(b.id);
      if (tb) {
        content.push({
          type: 'tool_use',
          id: b.id,
          name: tb.name,
          input:
            tb.input && typeof tb.input === 'object' && !Array.isArray(tb.input)
              ? (tb.input as Record<string, unknown>)
              : {},
        });
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  return { content, stopReason, usage, model };
}
