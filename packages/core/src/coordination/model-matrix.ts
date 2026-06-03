/**
 * Per-task model matrix resolution.
 *
 * The matrix (Config.modelMatrix) maps a catalog **role**, a **phase** name, or
 * the `*` default to a {@link ModelMatrixEntry} (model + optional provider).
 * At subagent spawn time we resolve the most specific match so different task
 * types can run on different models — e.g. `security-scanner` on one model,
 * `documentation` on another — while the leader keeps its own model.
 *
 * Resolution precedence (most → least specific):
 *   1. exact role          (matrix["security-scanner"])
 *   2. the role's phase     (matrix["review"])
 *   3. the `*` default      (matrix["*"])
 *   4. undefined            (caller falls back to the leader model)
 *
 * Set via the `/setmodel` slash command; this module is the single source of
 * truth both that command and the spawn path use to validate + resolve keys.
 */
import type { ModelMatrixEntry } from '../types/config.js';
import { AGENTS_BY_PHASE, AGENT_CATALOG } from './agents/index.js';

/** All valid phase keys, in catalog order. */
export const MATRIX_PHASE_KEYS: readonly string[] = Object.keys(AGENTS_BY_PHASE);

/** Role → phase lookup, built once from the catalog. */
const ROLE_TO_PHASE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [phase, defs] of Object.entries(AGENTS_BY_PHASE)) {
    for (const def of defs) {
      const role = def.config.role;
      if (role) map[role] = phase;
    }
  }
  return map;
})();

/** The phase a catalog role belongs to, or undefined for unknown roles. */
export function phaseForRole(role: string | undefined): string | undefined {
  return role ? ROLE_TO_PHASE[role] : undefined;
}

/**
 * Resolve the matrix entry for a subagent role. Returns the most specific
 * match (role → phase → `*`), or undefined when nothing matches.
 */
export function resolveModelMatrix(
  matrix: Record<string, ModelMatrixEntry> | undefined,
  role: string | undefined,
): ModelMatrixEntry | undefined {
  if (!matrix) return undefined;
  if (role && matrix[role]) return matrix[role];
  const phase = phaseForRole(role);
  if (phase && matrix[phase]) return matrix[phase];
  if (matrix['*']) return matrix['*'];
  return undefined;
}

export type MatrixKeyKind = 'role' | 'phase' | 'default' | 'unknown';

/** Classify a matrix key so `/setmodel` can reject typos before persisting. */
export function matrixKeyKind(key: string): MatrixKeyKind {
  if (key === '*') return 'default';
  if (key in AGENT_CATALOG) return 'role';
  if (MATRIX_PHASE_KEYS.includes(key)) return 'phase';
  return 'unknown';
}

/** True when `key` is a usable matrix key (role, phase, or `*`). */
export function isValidMatrixKey(key: string): boolean {
  return matrixKeyKind(key) !== 'unknown';
}
