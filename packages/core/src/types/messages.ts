import type { ContentBlock } from './blocks.js';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
  /**
   * Pre-computed token estimate for this message, set by
   * ConversationState on append/replace. Used by estimateMessageTokens
   * and estimateRequestTokens to skip the O(n·m) content-block walk
   * on every context-pressure check. Undefined means "not yet computed"
   * — the estimator falls back to walking content blocks.
   */
  _estTokens?: number | undefined;
}

export function asBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

export function asText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
}
