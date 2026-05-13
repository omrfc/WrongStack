export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Provider-specific opaque metadata captured from the wire response.
   * Echoed back verbatim in the next request so providers that bind
   * extra state to function calls keep working. Example: Gemini's
   * `thoughtSignature` — required for tool-use turns with thinking
   * models, otherwise the next request fails with 400 "Function call
   * is missing a thought_signature in functionCall parts".
   *
   * Keys are namespaced by intent so multiple wires can coexist:
   *   - `google.thoughtSignature` — Gemini signed-thought blob
   * Other providers can add their own keys without colliding.
   */
  providerMeta?: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /**
   * The original tool name. Useful for providers like Google Gemini that
   * need the tool name in `functionResponse.name` — the tool_use_id is
   * only a session-local identifier and is not stable across replays.
   * Always set by ToolExecutor; may be absent on manually-constructed blocks.
   */
  name?: string;
  content: string;
  is_error?: boolean;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === 'text';
}
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use';
}
export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === 'tool_result';
}
export function isImageBlock(b: ContentBlock): b is ImageBlock {
  return b.type === 'image';
}
