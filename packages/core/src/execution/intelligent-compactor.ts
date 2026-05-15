import type { Context } from '../core/context.js';
import type { ContentBlock, TextBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { Message } from '../types/messages.js';
import type { Provider, Request } from '../types/provider.js';
import {
  estimateTextTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '../utils/token-estimate.js';

/**
 * Options for IntelligentCompactor.
 */
export interface IntelligentCompactorOptions {
  /** Provider to use for LLM-assisted summarization. Required. */
  provider: Provider;
  /** Fraction of maxContext that triggers a warning (default 0.6). */
  warnThreshold?: number;
  /** Fraction of maxContext that triggers soft compaction (default 0.75). */
  softThreshold?: number;
  /** Fraction of maxContext that triggers hard compaction (default 0.9). */
  hardThreshold?: number;
  /** Max context window in tokens (used only for threshold fraction math). */
  maxContext?: number;
  /** How many recent (user+assistant) pairs to always preserve (default 4). */
  preserveK?: number;
  /** Token threshold below which tool results are not elided (default 500). */
  eliseThreshold?: number;
  /** System prompt for the summarizer sub-LLM. */
  summarizerPrompt?: string;
  /**
   * Model ID to use for summarization. When not set, the same model as the
   * agent is used (which risks cascading failure on context overflow). Set to
   * a fast/cheap model like `claude-3-5-haiku-20240620` for resilience.
   */
  summarizerModel?: string;
}

/**
 * An importance label for a message or message range.
 */
export type Importance = 'critical' | 'high' | 'medium' | 'low';

/**
 * Result of importance analysis.
 */
export interface ImportanceAnalysis {
  messages: Array<{ index: number; importance: Importance; reason: string }>;
  criticalRanges: Array<{ from: number; to: number; summary: string }>;
}

/**
 * IntelligentCompactor uses an LLM to:
 *  - Analyze message importance and preserve critical context
 *  - Generate semantic summaries for old message ranges
 *  - Make intelligent decisions about what to compact
 *
 * It extends HybridCompactor's elision logic with LLM-assisted summarization.
 */
export class IntelligentCompactor implements Compactor {
  private readonly provider: Provider;
  private readonly warnThreshold: number;
  private readonly softThreshold: number;
  private readonly hardThreshold: number;
  private readonly maxContext: number;
  private readonly preserveK: number;
  private readonly eliseThreshold: number;
  private readonly summarizerPrompt: string;
  private readonly summarizerModel?: string;

  constructor(opts: IntelligentCompactorOptions) {
    this.provider = opts.provider;
    this.warnThreshold = opts.warnThreshold ?? 0.6;
    this.softThreshold = opts.softThreshold ?? 0.75;
    this.hardThreshold = opts.hardThreshold ?? 0.9;
    this.maxContext = opts.maxContext ?? 128_000;
    this.preserveK = opts.preserveK ?? 4;
    this.eliseThreshold = opts.eliseThreshold ?? 500;
    this.summarizerPrompt =
      opts.summarizerPrompt ??
      'You are a context summarizer. Given a list of conversation messages, produce a concise but complete summary that preserves all factual information, decisions made, and any state changes (e.g. file edits, todo updates). Do not add commentary. Output only the summary.';
    this.summarizerModel = opts.summarizerModel;
  }

  async compact(ctx: Context, opts: { aggressive?: boolean } = {}): Promise<CompactReport> {
    const beforeTokens = this.estimateTokens(ctx.messages);
    const reductions: CompactReport['reductions'] = [];

    const load = beforeTokens / this.maxContext;
    // Past hardThreshold, force aggressive regardless of caller preference —
    // the alternative (lightweight elision) is unlikely to recover enough.
    const aggressive =
      load >= this.hardThreshold ? true : (opts.aggressive ?? load >= this.softThreshold);

    // Phase 1: always run elision (preserves recent K pairs)
    const saved1 = this.eliseOldToolResults(ctx);
    if (saved1 > 0) reductions.push({ phase: 'elision', saved: saved1 });

    // Phase 2: LLM summarization of ancient turns
    if (aggressive) {
      const saved2 = await this.summarizeAncientTurns(ctx);
      if (saved2 > 0) reductions.push({ phase: 'summary', saved: saved2 });
    } else if (load >= this.warnThreshold) {
      // Non-aggressive: do lightweight summarization via direct analysis
      const saved2 = this.lightweightCompact(ctx);
      if (saved2 > 0) reductions.push({ phase: 'elision', saved: saved2 });
    }

    const afterTokens = this.estimateTokens(ctx.messages);
    return { before: beforeTokens, after: afterTokens, reductions };
  }

  private async summarizeAncientTurns(ctx: Context): Promise<number> {
    const messages = ctx.messages;
    const cutoff = Math.max(0, messages.length - this.preserveK * 2);
    if (cutoff <= 2) return 0;

    // Find the best boundary in the ancient region
    const boundary = this.findSafeBoundary(messages, 0, cutoff);
    if (boundary <= 1) return 0;

    const toSummarize = messages.slice(0, boundary);
    const removedTokens = this.estimateTokens(toSummarize);

    let summaryText: string;
    try {
      summaryText = await this.callSummarizer(toSummarize, ctx);
    } catch {
      // Fallback: generic placeholder if summarizer fails
      summaryText = `[${toSummarize.length} earlier turns omitted — key decisions and file states preserved in context]`;
    }

    const summaryMsg: Message = {
      role: 'system',
      content: `[prior_turns_summary: ${summaryText}]`,
    };
    const summaryTokens = this.estimateTokens([summaryMsg]);

    // L1-A: route through ConversationState so subscribers see the rewrite.
    const tail = ctx.messages.slice(boundary);
    ctx.state.replaceMessages([summaryMsg, ...tail]);
    return Math.max(0, removedTokens - summaryTokens);
  }

  private findSafeBoundary(messages: Message[], from: number, to: number): number {
    // Find the nearest user message with text content at or after `to`
    // and walk backwards to find a safe cut point.
    for (let i = to; i >= from; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'user' && this.hasTextContent(m)) {
        // Ensure we don't cut inside a multi-message exchange
        // by finding the start of this exchange.
        return this.findExchangeStart(messages, i);
      }
    }
    return -1;
  }

  private findExchangeStart(messages: Message[], userIndex: number): number {
    // Walk backwards from userIndex to find where this logical exchange began.
    // An exchange starts after the last assistant message that had no tool calls.
    for (let i = userIndex - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'assistant') {
        const hasToolUse = Array.isArray(m.content)
          ? m.content.some((b) => b.type === 'tool_use')
          : false;
        if (!hasToolUse) {
          // This assistant msg had no tool calls — it's a boundary
          return i + 1;
        }
      } else if (m.role !== 'user') {
        // system or other — skip
      } else {
        // another user msg — boundary
        return i;
      }
    }
    return 0;
  }

  private async callSummarizer(messages: Message[], ctx: Context): Promise<string> {
    const prompt: TextBlock[] = [
      { type: 'text', text: this.summarizerPrompt },
      { type: 'text', text: '\n\nConversation to summarize:\n' },
      ...this.messagesToText(messages),
    ];

    const req: Request = {
      model: this.summarizerModel ?? ctx.model,
      system: prompt,
      messages: [],
      maxTokens: 1024,
    };

    // Use abort signal from context if available.
    // Fall back to a fresh controller only if ctx.signal is absent — this
    // avoids leaking AbortControllers on every summarizer call (the original
    // `?? new AbortController().signal` created a controller that was never
    // connected to anything, making cancellation a no-op).
    const ac = ctx.signal ? undefined : new AbortController();
    const signal = ctx.signal ?? ac!.signal;
    const res = await this.provider.complete(req, { signal });

    const textBlocks = res.content.filter(isTextBlock);
    return (
      textBlocks
        .map((b) => b.text)
        .join('\n')
        .trim() || '(empty summary)'
    );
  }

  private messagesToText(messages: Message[]): TextBlock[] {
    const lines: string[] = [];
    for (const m of messages) {
      const role = m.role.padEnd(10, ' ');
      if (typeof m.content === 'string') {
        lines.push(`[${role}]: ${m.content.slice(0, 500)}`);
      } else if (Array.isArray(m.content)) {
        const textParts = m.content.filter(isTextBlock).map((b) => b.text);
        if (textParts.length > 0) {
          lines.push(`[${role}]: ${textParts.join(' ').slice(0, 500)}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  }

  private lightweightCompact(ctx: Context): number {
    // Lightweight: just elide very large tool results without full summarization
    return this.eliseOldToolResults(ctx);
  }

  private eliseOldToolResults(ctx: Context): number {
    const messages = ctx.messages;
    let pairCount = 0;
    let preserveStart = messages.length;
    for (let i = messages.length - 1; i >= 0 && pairCount < this.preserveK; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'user' || m.role === 'assistant') {
        pairCount++;
        preserveStart = i;
      }
    }
    let saved = 0;
    let changed = false;
    const nextMessages = new Array(messages.length);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // Only process messages before the preservation window
      if (i >= preserveStart) {
        nextMessages[i] = msg;
        continue;
      }
      if (!msg || !Array.isArray(msg.content)) {
        nextMessages[i] = msg;
        continue;
      }
      const newContent: ContentBlock[] = msg.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        const tokens = estimateToolResultTokens(b.content);
        if (tokens < this.eliseThreshold) return b;
        saved += tokens;
        return {
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          content: `[elided: ~${tokens} tokens]`,
          is_error: b.is_error,
        };
      });
      // Check by reference equality whether any block actually changed
      if (
        newContent.length === msg.content.length &&
        newContent.every((b, idx) => b === msg.content[idx])
      ) {
        nextMessages[i] = msg;
      } else {
        nextMessages[i] = { ...msg, content: newContent };
        changed = true;
      }
    }
    if (changed) ctx.state.replaceMessages(nextMessages);
    return saved;
  }

  private hasTextContent(m: Message): boolean {
    if (typeof m.content === 'string') return m.content.trim().length > 0;
    return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
  }

  private estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') {
        total += estimateTextTokens(m.content);
      } else {
        for (const b of m.content) {
          if (b.type === 'text') total += estimateTextTokens(b.text);
          else if (b.type === 'tool_use') total += estimateToolInputTokens(b.input);
          else if (b.type === 'tool_result') total += estimateToolResultTokens(b.content);
        }
      }
    }
    return total;
  }
}
