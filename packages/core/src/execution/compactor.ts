import type { Context } from '../core/context.js';
import type { ContentBlock, ToolResultBlock } from '../types/blocks.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { ContextWindowPolicy } from '../types/context-window.js';
import type { Message } from '../types/messages.js';
import {
  estimateTextTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '../utils/token-estimate.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';

export interface CompactorOptions {
  preserveK?: number;
  eliseThreshold?: number;
  estimator?: (text: string) => number;
}

/**
 * Default tools config values shared across CLI and WebUI.
 * Import this instead of hardcoding to avoid cross-surface inconsistencies.
 * These mirror the values in BEHAVIOR_DEFAULTS (config-loader.ts).
 *
 * @deprecated Import from '../types/default-config.js' instead.
 *             This re-export exists for backward compatibility.
 */
export { DEFAULT_TOOLS_CONFIG, DEFAULT_CONTEXT_CONFIG, DEFAULT_AUTONOMY_CONFIG } from '../types/default-config.js';

export class HybridCompactor implements Compactor {
  private readonly preserveK: number;
  private readonly eliseThreshold: number;
  private readonly estimator: (text: string) => number;

  constructor(opts: CompactorOptions = {}) {
    this.preserveK = opts.preserveK ?? 5;
    this.eliseThreshold = opts.eliseThreshold ?? 2000;
    this.estimator = opts.estimator ?? estimateTextTokens;
  }

  async compact(ctx: Context, opts: { aggressive?: boolean } = {}): Promise<CompactReport> {
    const beforeTokens = this.estimateMessages(ctx.messages);
    const reductions: CompactReport['reductions'] = [];
    const policy = readContextWindowPolicy(ctx);
    const preserveK = policy?.preserveK ?? this.preserveK;
    const eliseThreshold = policy?.eliseThreshold ?? this.eliseThreshold;

    // Phase 1: elision
    const phase1Saved = this.eliseOldToolResults(ctx, preserveK, eliseThreshold);
    if (phase1Saved > 0) reductions.push({ phase: 'elision', saved: phase1Saved });

    // Phase 2: summary (placeholder; in production calls sub-LLM)
    if (opts.aggressive) {
      const phase2Saved = this.collapseAncientTurns(ctx, preserveK);
      if (phase2Saved > 0) reductions.push({ phase: 'summary', saved: phase2Saved });
    }

    const repaired = repairToolUseAdjacency(ctx.messages);
    if (repaired.report.changed) {
      ctx.state.replaceMessages(repaired.messages);
    }

    const afterTokens = this.estimateMessages(ctx.messages);
    return {
      before: beforeTokens,
      after: afterTokens,
      reductions,
      repaired: repaired.report.changed
        ? {
            removedToolUses: repaired.report.removedToolUses,
            removedToolResults: repaired.report.removedToolResults,
            removedMessages: repaired.report.removedMessages,
          }
        : undefined,
    };
  }

  private eliseOldToolResults(
    ctx: Context,
    preserveK = this.preserveK,
    eliseThreshold = this.eliseThreshold,
  ): number {
    const messages = ctx.messages;
    // Walk backwards counting (user + assistant) pairs to determine where
    // the preservation window really starts. This is more accurate than
    // the fixed multiplier which assumes every turn is 1 message pair.
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

    // Ensure tool_use/tool_result protocol pairs are preserved together.
    // Walk forward through the preserved window: if an assistant message
    // at or after preserveStart contains a tool_use, also preserve the
    // immediately following message (the tool_result) so neither is elided.
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
          // Extend preserveStart to cover the tool_result as well so
          // the protocol pair stays complete and readable.
          preserveStart = i + 1;
        }
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
        if (tokens < eliseThreshold) return b;
        saved += tokens;
        const elided: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          content: `[elided: ~${tokens} tokens]`,
          is_error: b.is_error,
        };
        return elided;
      });
      // Check whether any block actually changed by reference equality
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

  private collapseAncientTurns(ctx: Context, preserveK = this.preserveK): number {
    const messages = ctx.messages;
    const cutTarget = Math.max(0, messages.length - preserveK * 2);
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

    // L1-A: route through ConversationState so subscribers see the rewrite.
    const tail = ctx.messages.slice(boundary);
    ctx.state.replaceMessages([...summary, ...tail]);
    return Math.max(0, removedTokens - this.estimateMessages(summary));
  }

  private estimateMessages(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') {
        total += this.estimator(m.content);
      } else {
        for (const b of m.content) {
          if (b.type === 'text') total += this.estimator(b.text);
          else if (b.type === 'tool_use') total += estimateToolInputTokens(b.input);
          else if (b.type === 'tool_result') total += estimateToolResultTokens(b.content);
        }
      }
    }
    return total;
  }
}

function readContextWindowPolicy(ctx: Context): ContextWindowPolicy | null {
  const policy = ctx.meta?.['contextWindowPolicy'];
  if (!policy || typeof policy !== 'object') return null;
  const candidate = policy as Partial<ContextWindowPolicy>;
  if (
    typeof candidate.preserveK !== 'number' ||
    typeof candidate.eliseThreshold !== 'number'
  ) {
    return null;
  }
  return candidate as ContextWindowPolicy;
}

function hasTextContent(m: Message): boolean {
  if (typeof m.content === 'string') return m.content.trim().length > 0;
  return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
}
