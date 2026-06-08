import type { ContentBlock, ToolResultBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import { estimateMessageTokens, estimateToolResultTokens } from '../utils/token-estimate.js';

/**
 * Token estimate for a message array (text + tool I/O). Re-exported from the
 * canonical `token-estimate` helper so compactors and the context-pressure
 * monitor share one number.
 */
export const estimateMessages = estimateMessageTokens;

/**
 * Shared, pure compaction primitives.
 *
 * Before this module the three compactors (`HybridCompactor`,
 * `IntelligentCompactor`, `SelectiveCompactor`) each carried their own copies
 * of message-token estimation, tool-result elision, text detection and digest
 * rendering — with subtle divergences (notably Selective lacked the
 * tool_use/tool_result pair preservation, so it could elide the result of a
 * tool call it was supposed to keep). These helpers are the single source of
 * truth. They operate on plain `Message[]` and never touch `Context`/state, so
 * each compactor keeps its own `ctx.state.replaceMessages(...)` plumbing.
 */

/** Does this message carry any non-empty text? */
export function hasTextContent(m: Message): boolean {
  if (typeof m.content === 'string') return m.content.trim().length > 0;
  return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
}

/**
 * Index where the preserved (recent) window starts. Walks back counting
 * user/assistant messages until `preserveK` are covered, then walks forward to
 * keep any tool_use/tool_result protocol pair intact — so a tool_result whose
 * tool_use is preserved is never elided.
 */
export function findPreserveStart(messages: readonly Message[], preserveK: number): number {
  let pairCount = 0;
  let preserveStart = messages.length;
  for (let i = messages.length - 1; i >= 0 && pairCount < preserveK; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      pairCount++;
      preserveStart = i;
    }
  }

  // Forward walk: if a preserved assistant message has a tool_use, also keep the
  // immediately following tool_result so the protocol pair stays complete.
  for (let i = preserveStart; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content === 'string' || !Array.isArray(m.content)) continue;
    const hasToolUse = m.content.some((b) => b.type === 'tool_use');
    if (hasToolUse && i + 1 < messages.length) {
      const next = messages[i + 1];
      if (
        next &&
        next.role === 'user' &&
        typeof next.content !== 'string' &&
        Array.isArray(next.content) &&
        next.content.some((b) => b.type === 'tool_result')
      ) {
        preserveStart = i + 1;
      }
    }
  }
  return preserveStart;
}

export interface EliseResult {
  /** New message array, or the same reference when nothing changed. */
  messages: Message[];
  /** Estimated tokens reclaimed. */
  saved: number;
  changed: boolean;
}

/**
 * Elide oversized tool_results that fall before the preserve window. Pure:
 * returns a fresh array (or the same reference when unchanged). Replaces the
 * duplicate copies that lived in all three compactors.
 */
export function eliseOldToolResults(
  messages: readonly Message[],
  opts: { preserveK: number; eliseThreshold: number },
): EliseResult {
  const preserveStart = findPreserveStart(messages, opts.preserveK);
  let saved = 0;
  let changed = false;
  const next = new Array<Message>(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (i >= preserveStart || !msg || !Array.isArray(msg.content)) {
      next[i] = msg as Message;
      continue;
    }
    const original = msg.content;
    const newContent: ContentBlock[] = original.map((b) => {
      if (b.type !== 'tool_result') return b;
      const tokens = estimateToolResultTokens(b.content);
      if (tokens < opts.eliseThreshold) return b;
      saved += tokens;
      const elided: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: `[elided: ~${tokens} tokens]`,
        is_error: b.is_error,
      };
      return elided;
    });
    if (newContent.every((b, idx) => b === original[idx])) {
      next[i] = msg;
    } else {
      next[i] = { ...msg, content: newContent };
      changed = true;
    }
  }
  return { messages: changed ? next : (messages as Message[]), saved, changed };
}

/**
 * Lossless textual digest of a message range. Every text block is kept verbatim
 * (across all roles, so prior `system` digests fold forward and nothing
 * accumulates as loss). `tool_use` / `tool_result` blocks are counted and
 * replaced with a marker rather than serialized — their payload is already
 * persisted in the session log. Empty/tool-only messages are skipped.
 */
export function buildLosslessDigest(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    let text: string;
    let omitted = 0;
    if (typeof m.content === 'string') {
      text = m.content;
    } else {
      const parts: string[] = [];
      for (const b of m.content) {
        if (isTextBlock(b)) parts.push(b.text);
        else if (b.type === 'tool_use' || b.type === 'tool_result') omitted++;
      }
      text = parts.join(' ');
    }
    if (text.trim().length === 0 && omitted === 0) continue;
    const marker = omitted > 0 ? ` [${omitted} tool call(s) omitted — see session log]` : '';
    lines.push(`[${m.role}]: ${text}${marker}`);
  }
  return lines.join('\n');
}

/**
 * Nearest safe cut boundary in [from, to]: the start of the exchange of the
 * closest user-with-text message. Returns -1 when no such boundary exists.
 */
export function findSafeBoundary(messages: readonly Message[], from: number, to: number): number {
  for (let i = to; i >= from; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user' && hasTextContent(m)) {
      return findExchangeStart(messages, i);
    }
  }
  return -1;
}

/**
 * Walk backwards from a user message to find where its logical exchange began
 * (just after the last assistant message that made no tool calls).
 */
export function findExchangeStart(messages: readonly Message[], userIndex: number): number {
  for (let i = userIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'assistant') {
      const hasToolUse = Array.isArray(m.content)
        ? m.content.some((b) => b.type === 'tool_use')
        : false;
      if (!hasToolUse) return i + 1;
    } else if (m.role === 'user') {
      return i;
    }
  }
  return 0;
}
