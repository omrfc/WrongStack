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

// ── Content-aware scoring ─────────────────────────────────────────────────

/** Importance score for a message — drives retention vs. summarization. */
export type ContentScore = 0 | 1 | 2 | 3 | 4 | 5;
// 5 = critical (error, correction, decision) — keep verbatim
// 3 = medium   (normal exchange, successful tool) — keep first sentence
// 1 = low      (large tool result, grep output)    — one-line summary
// 0 = noise    (repeated failure pattern)          — collapse to count

/**
 * Extract the plain text from a message (ignoring tool blocks).
 * Returns empty string if no text content exists.
 */
export function extractText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.filter(isTextBlock).map((b) => b.text).join(' ');
}

/** Check if a message contains a tool_use block. */
export function hasToolUse(m: Message): boolean {
  if (typeof m.content === 'string') return false;
  return m.content.some((b) => b.type === 'tool_use');
}

/** Check if a message contains a tool_result block over the given char threshold. */
export function hasLargeToolResult(m: Message, threshold = 3000): boolean {
  if (typeof m.content === 'string') return false;
  return m.content.some(
    (b) =>
      b.type === 'tool_result' &&
      (b as ToolResultBlock).content &&
      (typeof (b as ToolResultBlock).content === 'string'
        ? (b as ToolResultBlock).content.length
        : JSON.stringify((b as ToolResultBlock).content).length) > threshold,
  );
}

/**
 * Score a message by content importance.
 *
 * CRITICAL (5): user corrections, explicit "no/wrong/stop", error messages,
 *   architecture decisions, security findings.
 * MEDIUM (3): normal exchanges, successful tool calls, file reads, edits.
 * LOW (1): large tool results (>3K chars), grep/file-list outputs, boilerplate.
 * NOISE (0): repeated identical failures (same tool, same error, 5th+ occurrence
 *   within the range), pure tool I/O with no text.
 */
export function scoreMessage(
  m: Message,
  context?: { failureCounts?: Map<string, number> },
): ContentScore {
  const text = extractText(m).toLowerCase();

  // ── Noise detection: pure tool I/O with no text ─────────────────────
  if (text.trim().length === 0 && (hasToolUse(m) || typeof m.content !== 'string')) {
    const hasResult = typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result');
    if (hasToolUse(m) || hasResult) return 0;
  }

  // ── Repeated failure detection ─────────────────────────────────────
  if (context?.failureCounts && m.role === 'user' && hasToolUse(m) === false) {
    // Check if this is a tool_result that matches a failure pattern
    const isFailure =
      /error|fail|exception|timeout|enonet|eacces|eperm|enoent|abort/i.test(text);
    if (isFailure) {
      // Build a key from the error type
      const errKey =
        /(error|fail|exception|timeout|enonet|eacces|eperm|enoent|abort)/i.exec(text)?.[0]?.toLowerCase() ?? 'error';
      const count = (context.failureCounts.get(errKey) ?? 0) + 1;
      context.failureCounts.set(errKey, count);
      if (count >= 5) return 0; // 5th+ identical failure → noise
      if (count >= 3) return 1; // 3rd-4th → low priority
    }
  }

  // ── Critical: user corrections / stop signals ──────────────────────
  if (m.role === 'user') {
    if (
      /\b(wrong|no\b|stop\b|don'?t\b|actually|fix that|undo|revert|forget|ignore|skip)\b/i.test(
        text,
      )
    ) {
      return 5;
    }
  }

  // ── Critical: error / exception messages ───────────────────────────
  if (
    /\b(error|exception|fatal|critical|crash|panic|abort|segfault|core dump|undefined is not|null pointer|typeerror|referenceerror|syntaxerror)\b/i.test(
      text,
    )
  ) {
    return 5;
  }

  // ── Critical: security findings ────────────────────────────────────
  if (
    /\b(security|vulnerability|injection|xss|csrf|secret|apikey|api.key|hardcoded|leak|exploit|cve)\b/i.test(
      text,
    )
  ) {
    return 5;
  }

  // ── Critical: architecture / design decisions ──────────────────────
  if (
    m.role === 'assistant' &&
    /\b(architecture|design|approach|strategy|pattern|refactor|migrate|restructure|decision|trade.?off)\b/i.test(
      text,
    )
  ) {
    return 5;
  }

  // ── Low: large tool results ────────────────────────────────────────
  if (hasLargeToolResult(m)) return 1;

  // ── Low: grep / list / tree outputs ────────────────────────────────
  if (
    m.role === 'user' && !hasToolUse(m) &&
    /\b(files_with_matches|count|found \d+ match|directory tree|\.\.\. and \d+ more)\b/i.test(text)
  ) {
    return 1;
  }

  // ── Default: medium ────────────────────────────────────────────────
  return 3;
}

/**
 * Build a content-aware digest of messages.
 *
 * Unlike `buildLosslessDigest` which preserves all text equally, this uses
 * `scoreMessage` to apply tiered treatment:
 * - Score 5 (critical): verbatim text
 * - Score 3 (medium):   first sentence only
 * - Score 1 (low):      one-line summary
 * - Score 0 (noise):    collapsed to count marker
 */
export function buildSmartDigest(messages: readonly Message[]): string {
  const lines: string[] = [];
  const failureCounts = new Map<string, number>();
  let noiseCount = 0;

  for (const m of messages) {
    const score = scoreMessage(m, { failureCounts });
    const text = extractText(m);
    const toolCount = countToolBlocks(m);

    if (score === 0) {
      noiseCount++;
      continue;
    }

    const marker = toolCount > 0 ? ` [${toolCount} tool call(s)]` : '';
    let display: string;

    switch (score) {
      case 5: // Critical — keep verbatim
        display = text.trim();
        break;
      case 3: // Medium — first sentence
        display = firstSentence(text);
        break;
      case 1: // Low — one-line summary
        display = oneLineSummary(m, text);
        break;
      default:
        display = firstSentence(text);
    }

    if (display.length === 0 && toolCount === 0) continue;
    lines.push(`[${m.role}]: ${display}${marker}`);
  }

  if (noiseCount > 0) {
    lines.push(`[system]: ${noiseCount} low-importance turn(s) collapsed (repeated failures / pure tool I/O)`);
  }

  return lines.join('\n');
}

function countToolBlocks(m: Message): number {
  if (typeof m.content === 'string') return 0;
  return m.content.filter(
    (b) => b.type === 'tool_use' || b.type === 'tool_result',
  ).length;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const dot = trimmed.indexOf('. ');
  if (dot === -1) return trimmed.length > 150 ? `${trimmed.slice(0, 147)}…` : trimmed;
  const sentence = trimmed.slice(0, dot + 1);
  return sentence.length > 150 ? `${sentence.slice(0, 147)}…` : sentence;
}

function oneLineSummary(m: Message, text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    // Pure tool result with no text
    if (typeof m.content !== 'string') {
      const results = m.content.filter((b) => b.type === 'tool_result');
      if (results.length > 0) {
        return `[${results.length} tool result(s) — see session log]`;
      }
    }
    return '[no text content]';
  }
  // Truncate to one line (~100 chars)
  const firstLine = trimmed.split('\n')[0] ?? '';
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
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
