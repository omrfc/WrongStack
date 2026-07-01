export type ConfirmDecision = 'yes' | 'no' | 'always' | 'deny';

export interface PendingConfirm {
  resolve: (decision: ConfirmDecision) => void;
  decisionSource?: string | undefined;
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
}

export function isDestructivePendingConfirm(confirm: PendingConfirm): boolean {
  return confirm.riskTier === 'destructive' || confirm.decisionSource === 'yolo_destructive';
}

export function resolveYoloEligiblePendingConfirms(
  pendingConfirms: Map<string, PendingConfirm>,
): void {
  for (const [id, confirm] of pendingConfirms) {
    if (isDestructivePendingConfirm(confirm)) continue;
    pendingConfirms.delete(id);
    confirm.resolve('yes');
  }
}

export function resolveAllPendingConfirms(
  pendingConfirms: Map<string, PendingConfirm>,
  decision: ConfirmDecision,
): void {
  for (const [id, confirm] of pendingConfirms) {
    pendingConfirms.delete(id);
    confirm.resolve(decision);
  }
}
