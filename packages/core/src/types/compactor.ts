import type { Context } from '../core/context.js';

export interface CompactReport {
  before: number;
  after: number;
  reductions: { phase: 'elision' | 'summary' | 'selective'; saved: number }[];
}

export interface Compactor {
  compact(ctx: Context, opts?: { aggressive?: boolean }): Promise<CompactReport>;
}
