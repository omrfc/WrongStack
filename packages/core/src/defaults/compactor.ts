import type { Compactor, CompactReport } from '../types/compactor.js';
import type { Context } from '../core/context.js';
import type { ContentBlock, ToolResultBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import { estimateToolInputTokens, estimateToolResultTokens, estimateTextTokens } from '../utils/token-estimate.js';

export interface CompactorOptions {
  preserveK?: number;
  eliseThreshold?: number;
  estimator?: (text: string) => number;
}

export class HybridCompactor implements Compactor {
  private readonly preserveK: number;
  private readonly eliseThreshold: number;
  private readonly estimator: (text: string) => number;

  constructor(opts: CompactorOptions = {}) {
    this.preserveK = opts.preserveK ?? 10;
    this.eliseThreshold = opts.eliseThreshold ?? 2000;
    this.estimator = opts.estimator ?? estimateTextTokens;
  }

  async compact(ctx: Context, opts: { aggressive?: boolean } = {}): Promise<CompactReport> {
    const beforeTokens = this.estimateMessages(ctx.messages);
    const reductions: CompactReport['reductions'] = [];

    // Phase 1: elision
    const phase1Saved = this.eliseOldToolResults(ctx);
    if (phase1Saved > 0) reductions.push({ phase: 'elision', saved: phase1Saved });

    // Phase 2: summary (placeholder; in production calls sub-LLM)
    if (opts.aggressive) {
      const phase2Saved = this.collapseAncientTurns(ctx);
      if (phase2Saved > 0) reductions.push({ phase: 'summary', saved: phase2Saved });
    }

    const afterTokens = this.estimateMessages(ctx.messages);
    return { before: beforeTokens, after: afterTokens, reductions };
  }

  private eliseOldToolResults(ctx: Context): number {
    const messages = ctx.messages;
    // Walk backwards counting (user + assistant) pairs to determine where
    // the preservation window really starts. This is more accurate than
    // the fixed multiplier which assumes every turn is 1 message pair.
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
    for (let i = 0; i < preserveStart; i++) {
      const msg = messages[i];
      if (!msg || !Array.isArray(msg.content)) continue;
      const newContent: ContentBlock[] = msg.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        const tokens = estimateToolResultTokens(b.content);
        if (tokens < this.eliseThreshold) return b;
        saved += tokens;
        const elided: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          content: `[elided: ~${tokens} tokens removed. Call the tool again if needed.]`,
          is_error: b.is_error,
        };
        return elided;
      });
      messages[i] = { ...msg, content: newContent };
    }
    return saved;
  }

  private collapseAncientTurns(ctx: Context): number {
    const messages = ctx.messages;
    const cutTarget = Math.max(0, messages.length - this.preserveK * 2);
    if (cutTarget <= 0) return 0;

    // Find a safe boundary: nearest user-message-with-text at or after cutTarget
    let boundary = -1;
    for (let i = cutTarget; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'user' && hasTextContent(m)) {
        boundary = i;
        break;
      }
    }
    if (boundary <= 0) return 0;

    const removed = messages.slice(0, boundary);
    const removedTokens = this.estimateMessages(removed);

    const summary: Message[] = [
      {
        role: 'user',
        content: `[previous_session_summary: ${removed.length} earlier turns compacted. Todo state preserved in context.]`,
      },
      { role: 'assistant', content: 'Continuing from compacted context.' },
    ];

    ctx.messages.splice(0, boundary, ...summary);
    return Math.max(0, removedTokens - this.estimateMessages(summary));
  }

  private estimateMessages(messages: Message[]): number {
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

function hasTextContent(m: Message): boolean {
  if (typeof m.content === 'string') return m.content.trim().length > 0;
  return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
}
