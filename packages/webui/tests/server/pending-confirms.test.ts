import { describe, expect, it } from 'vitest';
import {
  resolveAllPendingConfirms,
  resolveYoloEligiblePendingConfirms,
  type PendingConfirm,
} from '../../src/server/pending-confirms';

describe('pending confirm resolution', () => {
  it('auto-approves only non-destructive confirms when YOLO is enabled', () => {
    const pending = new Map<string, PendingConfirm>();
    const decisions: string[] = [];
    pending.set('safe', {
      resolve: (decision) => decisions.push(`safe:${decision}`),
      riskTier: 'standard',
    });
    pending.set('destructive', {
      resolve: (decision) => decisions.push(`destructive:${decision}`),
      decisionSource: 'yolo_destructive',
      riskTier: 'destructive',
    });

    resolveYoloEligiblePendingConfirms(pending);

    expect(decisions).toEqual(['safe:yes']);
    expect(pending.has('safe')).toBe(false);
    expect(pending.has('destructive')).toBe(true);
  });

  it('resolves every pending confirm with the provided decision', () => {
    const pending = new Map<string, PendingConfirm>();
    const decisions: string[] = [];
    pending.set('one', { resolve: (decision) => decisions.push(`one:${decision}`) });
    pending.set('two', { resolve: (decision) => decisions.push(`two:${decision}`) });

    resolveAllPendingConfirms(pending, 'no');

    expect(decisions).toEqual(['one:no', 'two:no']);
    expect(pending.size).toBe(0);
  });
});
