/**
 * Agent catalog aggregator.
 *
 * Collects every phase's `AgentDefinition[]` into:
 *   - `ALL_AGENT_DEFINITIONS` — flat list, catalog order (phase 1 → 9)
 *   - `AGENT_CATALOG`         — keyed by role for O(1) lookup
 *   - `AGENTS_BY_PHASE`       — grouped for statusline / dispatcher tie-breaks
 *
 * `fleet.ts` derives `FLEET_ROSTER` + `FLEET_ROSTER_BUDGETS` from this, and the
 * dispatcher routes free-form tasks against `capability` metadata here.
 */
import type { AgentDefinition, AgentPhase } from './types.js';
import { DISCOVERY_AGENTS } from './phase1-discovery.js';
import { PLANNING_AGENTS } from './phase2-planning.js';
import { BUILD_AGENTS } from './phase3-build.js';
import { VERIFY_AGENTS } from './phase4-verify.js';
import { REVIEW_AGENTS } from './phase5-review.js';
import { DOMAIN_AGENTS } from './phase6-domain.js';
import { KNOWLEDGE_AGENTS } from './phase7-knowledge.js';
import { DELIVERY_AGENTS } from './phase8-delivery.js';
import { META_AGENTS } from './phase9-meta.js';

export * from './types.js';
export {
  DISCOVERY_AGENTS,
  PLANNING_AGENTS,
  BUILD_AGENTS,
  VERIFY_AGENTS,
  REVIEW_AGENTS,
  DOMAIN_AGENTS,
  KNOWLEDGE_AGENTS,
  DELIVERY_AGENTS,
  META_AGENTS,
};

/** Every catalog agent, in phase order. */
export const ALL_AGENT_DEFINITIONS: AgentDefinition[] = [
  ...DISCOVERY_AGENTS,
  ...PLANNING_AGENTS,
  ...BUILD_AGENTS,
  ...VERIFY_AGENTS,
  ...REVIEW_AGENTS,
  ...DOMAIN_AGENTS,
  ...KNOWLEDGE_AGENTS,
  ...DELIVERY_AGENTS,
  ...META_AGENTS,
];

/** Phase → its agents, for grouped display and dispatcher fallbacks. */
export const AGENTS_BY_PHASE: Record<AgentPhase, AgentDefinition[]> = {
  discovery: DISCOVERY_AGENTS,
  planning: PLANNING_AGENTS,
  build: BUILD_AGENTS,
  verify: VERIFY_AGENTS,
  review: REVIEW_AGENTS,
  domain: DOMAIN_AGENTS,
  knowledge: KNOWLEDGE_AGENTS,
  delivery: DELIVERY_AGENTS,
  meta: META_AGENTS,
};

/**
 * Role → definition. Built once at module load. Throws on a duplicate role so
 * a copy-paste collision fails loudly at startup instead of silently shadowing.
 */
export const AGENT_CATALOG: Record<string, AgentDefinition> = (() => {
  const map: Record<string, AgentDefinition> = {};
  for (const def of ALL_AGENT_DEFINITIONS) {
    const role = def.config.role;
    if (!role) {
      throw new Error(`Agent "${def.config.name}" is missing a role`);
    }
    if (map[role]) {
      throw new Error(`Duplicate agent role in catalog: "${role}"`);
    }
    map[role] = def;
  }
  return map;
})();

/** Role lookup helper. Returns undefined for unknown roles. */
export function getAgentDefinition(role: string): AgentDefinition | undefined {
  return AGENT_CATALOG[role];
}
