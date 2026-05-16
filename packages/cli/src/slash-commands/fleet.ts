import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildFleetCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'fleet',
    description:
      'Inspect or control the subagent fleet: /fleet [status|usage|kill <id>|manifest|retry [taskId]|log <id>|stream on|off|help]',
    help: [
      'Usage:',
      '  /fleet                  Show fleet status (alias for /fleet status).',
      '  /fleet status           Pending + completed subagent task table.',
      '  /fleet usage            Per-subagent runtime cost.',
      '  /fleet kill <id>        Terminate a running subagent.',
      '  /fleet manifest         Print the director manifest.',
      '  /fleet retry            List interrupted tasks from the last run.',
      '  /fleet retry <taskId>   Re-spawn the matching subagent and re-assign the task.',
      '  /fleet retry all        Re-assign every interrupted task at once.',
      '  /fleet log              List subagent transcripts available on disk.',
      '  /fleet log <id>         Print a compact summary of a subagent transcript.',
      '  /fleet log <id> raw     Dump the full per-subagent JSONL.',
      '  /fleet stream on|off    Show/hide subagent activity in the main history.',
      '  /fleet help             Show this help.',
    ].join('\n'),
    async run(args) {
      if (!opts.onFleet) return { message: 'Multi-agent is not enabled in this session.' };
      const trimmed = args.trim();
      const [verb, ...rest] = trimmed.length === 0 ? ['status'] : trimmed.split(/\s+/);
      const target = rest.join(' ').trim() || undefined;
      switch (verb) {
        case 'status':
        case 'usage':
        case 'manifest': {
          const out = await opts.onFleet(verb, undefined);
          return { message: out };
        }
        case 'kill': {
          if (!target) return { message: 'Usage: /fleet kill <subagent-id>' };
          return { message: await opts.onFleet('kill', target) };
        }
        case 'retry': {
          if (!opts.onFleetRetry) {
            return { message: 'Retry is only available when director mode is active.' };
          }
          const msg = await opts.onFleetRetry(target);
          return { message: msg };
        }
        case 'log': {
          if (!opts.onFleetLog) {
            return { message: 'Log inspection is only available when a fleet root is configured.' };
          }
          // Second word after the id, if any, picks the rendering mode
          // (raw vs summary). Default: summary.
          const [id, ...modeRest] = rest;
          const mode = modeRest.join(' ').trim() === 'raw' ? 'raw' : 'summary';
          return { message: await opts.onFleetLog(id, mode) };
        }
        case 'stream': {
          const ctrl = opts.fleetStreamController;
          if (!ctrl) {
            return { message: 'Stream toggle is only available in the TUI.' };
          }
          const arg = (target ?? '').toLowerCase();
          if (arg === '' || arg === 'status') {
            return { message: `Fleet streaming is ${ctrl.enabled ? 'on' : 'off'}.` };
          }
          if (arg !== 'on' && arg !== 'off') {
            return { message: 'Usage: /fleet stream on|off' };
          }
          const enabled = arg === 'on';
          ctrl.setEnabled(enabled);
          ctrl.enabled = enabled;
          return { message: `Fleet streaming ${enabled ? 'enabled' : 'disabled'}.` };
        }
        case 'help':
        case '?':
          return {
            message: [
              '/fleet — inspect or control the subagent fleet',
              '',
              '  /fleet                  → status (default)',
              '  /fleet status           pending + completed tasks per subagent',
              '  /fleet usage            iterations, tool calls, duration roll-up',
              '  /fleet kill <id>        terminate a subagent',
              '  /fleet manifest         director manifest (requires --director)',
            ].join('\n'),
          };
        default:
          return {
            message: `Unknown subcommand "${verb}". Try: status | usage | kill <id> | manifest | help`,
          };
      }
    },
  };
}
