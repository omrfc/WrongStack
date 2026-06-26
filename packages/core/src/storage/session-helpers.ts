import type { ContentBlock } from '../types/blocks.js';

/**
 * Derive a short title from a user_input event's content. Used by both
 * `DefaultSessionStore.summarize()` (offline summary rebuild) and
 * `FileSessionWriter.observeForSummary()` (live tracking), so it lives
 * here to avoid a bidirectional import between those two modules.
 */
export function userInputTitle(content: string | ContentBlock[]): string {
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join(' ');
  return (text || '(non-text input)').slice(0, 60);
}
