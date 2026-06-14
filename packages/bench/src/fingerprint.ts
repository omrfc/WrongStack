import { createHash } from 'node:crypto';
import type { HarnessFingerprint } from './types.js';

/**
 * Compute the harness fingerprint. This is what makes a report
 * "model-independent": every cell in a run shares one fingerprint, so the only
 * thing that varies across leaderboard rows is the model. Change the CLI
 * version, the tool roster, the iteration cap, the yolo flag, or the task
 * subset and the hash changes — which is exactly when old numbers stop being
 * comparable.
 *
 * The hash is intentionally cheap and reproducible: no timestamps, no random
 * salt. Same inputs → same hash, on any machine.
 */
export function computeHarnessFingerprint(input: {
  cliVersion: string;
  toolNames: string[];
  maxIterations: number;
  yolo: boolean;
  subsetId: string;
}): HarnessFingerprint {
  const toolNames = [...input.toolNames].sort((a, b) => a.localeCompare(b));
  // Canonical, order-stable serialization of every field that affects results.
  const canonical = JSON.stringify({
    cliVersion: input.cliVersion,
    toolNames,
    maxIterations: input.maxIterations,
    yolo: input.yolo,
    subsetId: input.subsetId,
  });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return {
    cliVersion: input.cliVersion,
    toolNames,
    maxIterations: input.maxIterations,
    yolo: input.yolo,
    subsetId: input.subsetId,
    hash,
  };
}

/** One-line human label for report headers: `wrongstack@0.255 · fp:a3f9c7 · maxIter=40 · yolo`. */
export function fingerprintLabel(fp: HarnessFingerprint): string {
  const parts = [`wrongstack@${fp.cliVersion}`, `fp:${fp.hash}`, `maxIter=${fp.maxIterations}`];
  if (fp.yolo) parts.push('yolo');
  return parts.join(' · ');
}
