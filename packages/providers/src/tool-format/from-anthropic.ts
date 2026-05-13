import type { ContentBlock } from '@wrongstack/core';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  source?: {
    type?: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface FromAnthropicOptions {
  /**
   * Called once for each block whose `type` the converter doesn't recognize.
   * The block is still dropped — this hook only exists so callers can wire
   * it into observability (event bus, logger) instead of silently losing
   * data. Anthropic ships new block types over time (`thinking`,
   * `server_tool_use`, etc.) and we want a way to find out without
   * inflating the conversion logic itself.
   */
  onUnsupported?: (type: string, block: AnthropicBlock) => void;
}

export function contentFromAnthropic(
  blocks: AnthropicBlock[],
  opts: FromAnthropicOptions = {},
): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use' && b.id && b.name) {
      const input = isPlainObject(b.input)
        ? (b.input as Record<string, unknown>)
        : {};
      out.push({ type: 'tool_use', id: b.id, name: b.name, input });
    } else if (b.type === 'tool_result' && b.tool_use_id) {
      out.push({
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: normalizeToolResultContent(b.content, opts),
        is_error: b.is_error,
      });
    } else if (b.type === 'image' && b.source) {
      const src = b.source;
      const kind = src.type === 'url' ? 'url' : 'base64';
      out.push({
        type: 'image',
        source: {
          type: kind,
          ...(src.media_type ? { media_type: src.media_type } : {}),
          ...(src.data ? { data: src.data } : {}),
          ...(src.url ? { url: src.url } : {}),
        },
      });
    } else if (b.type) {
      opts.onUnsupported?.(b.type, b);
    }
  }
  return out;
}

/**
 * Convert Anthropic's tool_result content to our canonical string format.
 * Anthropic ships tool_result.content as either a plain string or an array
 * of `{ type: 'text', text }` / `{ type: 'image', source }` sub-blocks.
 * We flatten sub-block arrays to a string so the canonical type stays `string`.
 * If the caller needs the raw array structure (e.g. for image preservation),
 * they should call `contentFromAnthropic` directly on the raw Anthropic block
 * instead of going through a ToolResultBlock.
 */
function normalizeToolResultContent(
  raw: unknown,
  opts: FromAnthropicOptions,
): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    // Flatten sub-block structure to a text representation.
    // Callers who need the full structure should use contentFromAnthropic
    // directly on the raw Anthropic block before constructing a ToolResultBlock.
    const blocks = contentFromAnthropic(raw as AnthropicBlock[], opts);
    return blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
  }
  if (raw === undefined || raw === null) return '';
  return JSON.stringify(raw);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
