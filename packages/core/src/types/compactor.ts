import type { Context } from '../core/context.js';

export interface CompactRepairReport {
  removedToolUses: string[];
  removedToolResults: string[];
  removedMessages: number;
}

export interface CompactReport {
  /**
   * Token count of messages only (pre-compaction).
   * Use `fullRequestTokensBefore` for accurate context-window load calculations.
   */
  before: number;
  /**
   * Token count of messages only (post-compaction).
   * Use `fullRequestTokensAfter` for accurate context-window load calculations.
   */
  after: number;
  /**
   * Full API request token count before compaction: messages + systemPrompt + toolDefs.
   * This is the accurate figure for context-window pressure monitoring.
   */
  fullRequestTokensBefore: number;
  /**
   * Full API request token count after compaction: messages + systemPrompt + toolDefs.
   * This is the accurate figure for context-window pressure monitoring.
   */
  fullRequestTokensAfter: number;
  reductions: { phase: 'elision' | 'summary' | 'selective'; saved: number }[];
  repaired?: CompactRepairReport;
}

export interface Compactor {
  compact(ctx: Context, opts?: { aggressive?: boolean }): Promise<CompactReport>;
}
