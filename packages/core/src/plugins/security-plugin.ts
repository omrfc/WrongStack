import type { Plugin } from '../types/plugin.js';
import { createSecuritySlashCommand } from '../security-scanner/slash-command.js';

/**
 * SecurityPlugin — automated security scanning.
 *
 * Registers `/security` (scan | audit | report). First-party ("official")
 * plugin, so the command keeps its bare name. Wraps the canonical
 * `createSecuritySlashCommand`, which reads the live provider off `ctx`.
 */
export function createSecurityPlugin(): Plugin {
  return {
    name: 'wstack-security',
    version: '1.0.0',
    description: 'Security scanning: /security scan | audit | report',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      api.slashCommands.register(createSecuritySlashCommand());
      api.log.info('[security] loaded — /security available');
    },

    teardown(api) {
      api.slashCommands.unregister('security');
      api.log.info('[security] unloaded');
    },

    async health() {
      return { ok: true, message: 'security scanner ready' };
    },
  };
}
