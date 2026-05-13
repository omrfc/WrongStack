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
