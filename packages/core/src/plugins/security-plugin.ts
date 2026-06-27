import type { Plugin } from '../types/plugin.js';

/**
 * SecurityPlugin — automated security scanning back-end.
 *
 * Exposes the LLM-powered `defaultOrchestrator` programmatically. The
 * synchronous TUI surface is owned by the CLI built-in
 * `packages/cli/src/slash-commands/security.ts` (`/security audit-deps |
 * scan | redact-test | help`), which intentionally does NOT invoke the
 * orchestrator — slash commands run on a sync surface and a full scan
 * takes minutes. To run a real scan, dispatch a subagent from the TUI
 * (`/security scan` prints the dispatch instructions).
 *
 * Do NOT register a `/security` slash command here — it would shadow the
 * CLI built-in and leave users staring at a silent prompt while an
 * LLM scan hangs in the background. The `createSecuritySlashCommand`
 * factory remains exported for programmatic/test use only.
 */
export function createSecurityPlugin(): Plugin {
  return {
    name: 'wstack-security',
    version: '1.0.0',
    description: 'Security scanning back-end (orchestrator only).',
    apiVersion: '^0.1',
    capabilities: {},
    defaultConfig: {},

    setup(_api) {
      // Intentionally no slash-command registration. The CLI owns /security.
      _api.log.info('[security] loaded — orchestrator available programmatically');
    },

    teardown(_api) {
      _api.log.info('[security] unloaded');
    },

    async health() {
      return { ok: true, message: 'security scanner ready' };
    },
  };
}
