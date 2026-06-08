import type { Context } from '../core/context.js';
import { LLMSelector } from '../models/llm-selector.js';
import { isTextBlock } from '../types/blocks.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { Message } from '../types/messages.js';
import type { Provider, Request } from '../types/provider.js';
import type { MessageSelector, SelectorResult } from '../types/selector.js';
import { estimateRequestTokens } from '../utils/token-estimate.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { eliseOldToolResults as coreEliseOldToolResults } from './compaction-core.js';

/**
 * Options for SelectiveCompactor — the most configurable compactor.
 */
export interface SelectiveCompactorOptions {
  /** Provider for LLM calls (selector + summarizer). Required. */
  provider: Provider;
  /** Selector for LLM-driven importance analysis. */
  selector?: MessageSelector | undefined;
  /** Fraction of maxContext that triggers a warning (default 0.6). */
  warnThreshold?: number | undefined;
  /** Fraction of maxContext that triggers soft compaction (default 0.75). */
  softThreshold?: number | undefined;
  /** Fraction of maxContext that triggers hard compaction (default 0.9). */
  hardThreshold?: number | undefined;
  /** Max context window in tokens (used for threshold fraction math). */
  maxContext?: number | undefined;
  /** How many recent (user+assistant) pairs to always preserve (default 4). */
  preserveK?: number | undefined;
  /** Token threshold below which tool results are not elided (default 500). */
  eliseThreshold?: number | undefined;
  /** Model for selector LLM calls (default: same as provider default). */
  selectorModel?: string | undefined;
  /** Summarizer model for collapsed ranges (default: same as selectorModel). */
  summarizerModel?: string | undefined;
  /** Prompt for the summarizer sub-LLM. */
  summarizerPrompt?: string | undefined;
}

/**
 * SelectiveCompactor uses an LLM-driven MessageSelector to make
 * surgical decisions about which message ranges to keep vs collapse.
 *
 * Compared to HybridCompactor / IntelligentCompactor:
 * - HybridCompactor: rule-based (preserveK + elision), no LLM calls
 * - IntelligentCompactor: LLM summarization but no structured selection
 * - SelectiveCompactor: full LLM-driven selection + optional summarization
 */
export class SelectiveCompactor implements Compactor {
  private readonly provider: Provider;
  private readonly selector: MessageSelector;
  private readonly warnThreshold: number;
  private readonly softThreshold: number;
  private readonly hardThreshold: number;
  private readonly maxContext: number;
  private readonly preserveK: number;
  private readonly eliseThreshold: number;
  private readonly summarizerModel: string;
  private readonly summarizerPrompt: string;

  constructor(opts: SelectiveCompactorOptions) {
    this.provider = opts.provider;
    this.selector =
      opts.selector ?? new LLMSelector({ provider: opts.provider, model: opts.selectorModel });
    this.warnThreshold = opts.warnThreshold ?? 0.6;
    this.softThreshold = opts.softThreshold ?? 0.75;
    this.hardThreshold = opts.hardThreshold ?? 0.9;
    this.maxContext = opts.maxContext ?? 128_000;
    this.preserveK = opts.preserveK ?? 4;
    this.eliseThreshold = opts.eliseThreshold ?? 500;
    this.summarizerModel = opts.summarizerModel ?? opts.selectorModel ?? 'unknown';
    this.summarizerPrompt =
      opts.summarizerPrompt ??
      'You are a context summarizer. Given a list of messages, produce a concise summary that preserves all factual information, decisions, file changes, and state changes. Do not add commentary or opinions.';
  }

  async compact(ctx: Context, opts: { aggressive?: boolean | undefined } = {}): Promise<CompactReport> {
    const beforeTokens = this.estimateTokens(ctx.messages);
    const beforeFull = this.estimateFullRequest(ctx);
    const reductions: CompactReport['reductions'] = [];

    // Use full request tokens for threshold decisions — messages alone are inaccurate.
    const load = beforeFull / this.maxContext;
    const shouldCompact = load >= this.warnThreshold || opts.aggressive;

    if (!shouldCompact) {
      // Only do lightweight elision if below warn threshold
      const saved = this.eliseOldToolResults(ctx);
      if (saved > 0) reductions.push({ phase: 'elision', saved });
      const repair = this.repairProtocolAdjacency(ctx);
      const afterTokens = this.estimateTokens(ctx.messages);
      const afterFull = this.estimateFullRequest(ctx);
      return {
        before: beforeTokens,
        after: afterTokens,
        fullRequestTokensBefore: beforeFull,
        fullRequestTokensAfter: afterFull,
        reductions,
        repaired: repair,
      };
    }

    // Phase 1: elision — always run first to get a baseline reduction
    const savedElision = this.eliseOldToolResults(ctx);
    if (savedElision > 0) reductions.push({ phase: 'elision', saved: savedElision });

    // Phase 2: LLM-driven selective compaction
    const afterPhase1 = this.estimateTokens(ctx.messages);
    const targetBudget = this.computeTargetBudget(load);

    if (afterPhase1 > targetBudget) {
      const savedSelective = await this.runSelector(ctx, targetBudget);
      if (savedSelective > 0) reductions.push({ phase: 'selective', saved: savedSelective });
    }

    const repair = this.repairProtocolAdjacency(ctx);
    const afterTokens = this.estimateTokens(ctx.messages);
    const afterFull = this.estimateFullRequest(ctx);
    return {
      before: beforeTokens,
      after: afterTokens,
      fullRequestTokensBefore: beforeFull,
      fullRequestTokensAfter: afterFull,
      reductions,
      repaired: repair,
    };
  }

  /**
   * Estimate the full API request token count: messages + systemPrompt + toolDefs.
   * This is the accurate figure for context-window pressure monitoring.
   */
  private estimateFullRequest(ctx: Context): number {
    const breakdown = estimateRequestTokens(ctx.messages, ctx.systemPrompt, ctx.tools ?? []);
    return breakdown.total;
  }

  private repairProtocolAdjacency(ctx: Context): CompactReport['repaired'] {
    const repaired = repairToolUseAdjacency(ctx.messages);
    if (repaired.report.changed) ctx.state.replaceMessages(repaired.messages);
    return repaired.report.changed
      ? {
          removedToolUses: repaired.report.removedToolUses,
          removedToolResults: repaired.report.removedToolResults,
          removedMessages: repaired.report.removedMessages,
        }
      : undefined;
  }

  /**
   * Run the LLM selector to decide what to keep vs collapse.
   * Returns the token savings achieved.
   */
  private async runSelector(ctx: Context, targetBudget: number): Promise<number> {
    const before = this.estimateTokens(ctx.messages);

    let result: SelectorResult;
    try {
      result = await this.selector.select(ctx.messages, targetBudget);
    } catch {
      // Fallback to aggressive recency preservation
      return this.aggressiveRecencyTrim(ctx);
    }

    // Execute the selector's plan
    await this.executePlan(ctx, result);

    const after = this.estimateTokens(ctx.messages);
    return Math.max(0, before - after);
  }

  /**
   * Execute a SelectorResult plan: collapse/remove ranges and
   * insert summaries where the selector provided them.
   */
  private async executePlan(ctx: Context, plan: SelectorResult): Promise<void> {
    if (ctx.messages.length === 0) return;

    // Process collapsed ranges in reverse order to preserve indices. We work
    // on a local copy and commit through `ctx.state.replaceMessages` at the
    // end so subscribers see a single state change for the whole rewrite.
    const messages = [...ctx.messages];
    const sortedCollapsed = [...plan.collapsed].sort((a, b) => b.from - a.from);

    for (const range of sortedCollapsed) {
      if (range.from < 0 || range.to >= messages.length || range.from > range.to) continue;

      let summary = range.summary;
      if (!summary) {
        const toSummarize = messages.slice(range.from, range.to + 1);
        summary = await this.summarizeRange(toSummarize, ctx);
      }

      const summaryMsg: Message = {
        role: 'system',
        content: `[prior_turns_${range.from}-${range.to}: ${summary}]`,
      };

      messages.splice(range.from, range.to - range.from + 1, summaryMsg);
    }

    ctx.state.replaceMessages(messages);
  }

  private async summarizeRange(messages: Message[], ctx: Context): Promise<string> {
    const systemText = `${this.summarizerPrompt}\n\nSummarize the following message range:`;
    const body = messages.map((m, i) => `[${i}] ${m.role}: ${this.messagePreview(m)}`).join('\n');

    const req: Request = {
      model: this.summarizerModel,
      system: [{ type: 'text', text: systemText }],
      messages: [{ role: 'user', content: body }],
      maxTokens: 512,
    };

    try {
      const res = await this.provider.complete(req, {
        signal: ctx.signal ?? new AbortController().signal,
      });
      return (
        res.content
          .filter(isTextBlock)
          .map((b) => b.text)
          .join('\n')
          .trim() || '(empty)'
      );
    } catch {
      return `[${messages.length} earlier turns omitted]`;
    }
  }

  private messagePreview(m: Message): string {
    if (typeof m.content === 'string') return m.content.slice(0, 300);
    return m.content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join(' ')
      .slice(0, 300);
  }

  /**
   * Fallback when selector fails: aggressively trim from the oldest end
   * until we hit targetBudget.
   */
  private aggressiveRecencyTrim(ctx: Context): number {
    const messages = ctx.messages;
    const preserveIdx = Math.max(0, messages.length - this.preserveK * 2);

    if (preserveIdx <= 0) return 0;

    // Find safe boundary near preserveIdx
    let boundary = preserveIdx;
    for (let i = preserveIdx; i < messages.length && i < preserveIdx + 6; i++) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'user' && this.hasTextContent(m)) {
        boundary = i;
        break;
      }
    }

    const removed = messages.slice(0, boundary);
    const removedTokens = this.estimateTokens(removed);

    const summaryMsg: Message = {
      role: 'system',
      content: `[${removed.length} earlier turns trimmed — see session log for details]`,
    };
    const tail = messages.slice(boundary);
    ctx.state.replaceMessages([summaryMsg, ...tail]);

    return Math.max(0, removedTokens - this.estimateTokens([summaryMsg]));
  }

  private computeTargetBudget(load: number): number {
    if (load >= this.hardThreshold) {
      return Math.floor(this.maxContext * 0.5); // keep only 50%
    }
    if (load >= this.softThreshold) {
      return Math.floor(this.maxContext * 0.65); // keep 65%
    }
    return Math.floor(this.maxContext * 0.75); // keep 75% at warn
  }

  private eliseOldToolResults(ctx: Context): number {
    // Delegate to the shared core so SelectiveCompactor gets the same
    // tool_use/tool_result pair preservation as the other compactors — its
    // previous local copy lacked the forward walk and could elide the result
    // of a tool call it was supposed to keep.
    const result = coreEliseOldToolResults(ctx.messages, {
      preserveK: this.preserveK,
      eliseThreshold: this.eliseThreshold,
    });
    if (result.changed) ctx.state.replaceMessages(result.messages);
    return result.saved;
  }

  private hasTextContent(m: Message): boolean {
    if (typeof m.content === 'string') return m.content.trim().length > 0;
    return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
  }

  private estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') {
        total += this.roughTokenEstimate(m.content);
      } else {
        for (const b of m.content) {
          if (b.type === 'text') total += this.roughTokenEstimate(b.text);
          else if (b.type === 'tool_use') total += this.roughTokenEstimate(JSON.stringify(b.input));
          else if (b.type === 'tool_result') {
            total += this.roughTokenEstimate(
              typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
            );
          }
        }
      }
    }
    return total;
  }

  private roughTokenEstimate(text: string): number {
    return Math.max(1, Math.ceil(text.length / 3.5));
  }
}
