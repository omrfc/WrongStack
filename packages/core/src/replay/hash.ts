import { createHash } from 'node:crypto';
import type { Request } from '../types/provider.js';

/**
 * Idea #2 from IDEAS.md — Deterministic Replay.
 *
 * The hash function is the foundation of replay: given a `Request`,
 * produce a stable identifier so a recorded `Response` can be looked
 * up later when we want to "re-run" the same agent loop without
 * burning API credits.
 *
 * Stability rules:
 *
 *   - All object keys are sorted recursively before stringification.
 *     Without this, two semantically identical requests that differ
 *     only in key insertion order would produce different hashes.
 *   - We hash ONLY the fields that affect the response: `model`,
 *     `system`, `messages`, `tools`, `maxTokens`, and the four
 *     sampling knobs (`temperature`, `topP`, `stopSequences`,
 *     `toolChoice`). Anything else on the `Request` (metadata,
 *     future extensions) is ignored so replay stays forward-compat.
 *   - We serialize to JSON. The `ContentBlock` and `Message` shapes
 *     are pure data; this works as long as no `undefined` values
 *     sneak in (those get dropped by `JSON.stringify`, which is
 *     fine — the structural diff is what matters).
 *
 * The SHA-256 output is hex-encoded and prefixed with the algorithm
 * tag so a future migration to a different hash (e.g. blake3) is
 * trivial to detect.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

export function hashRequest(request: Request): string {
  // Pick only the fields that affect the response. See stability rules.
  const payload = {
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    topP: request.topP,
    stopSequences: request.stopSequences,
    toolChoice: request.toolChoice,
  };
  const json = stableStringify(payload);
  const digest = createHash('sha256').update(json, 'utf8').digest('hex');
  return `sha256:${digest}`;
}
