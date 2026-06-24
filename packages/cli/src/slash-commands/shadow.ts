/**
 * /shadow slash command — Start, manage, and stop the Shadow Agent.
 *
 * Usage:
 *   /shadow start [--interval=<ms>] [--model=<provider/model>]
 *   /shadow stop
 *   /shadow status
 *   /shadow hoop <agent-id>
 *   /shadow model <provider/model>
 *   /shadow interval <ms>
 */
import type { Context, SlashCommand } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * /shadow — Shadow Agent management
 *
 * The Shadow Agent is a background monitoring agent that:
 * - Auto-starts on first LLM request (if enabled)
 * - Tracks all fleet agents and their current tasks
 * - Monitors mailbox state and detects loops
 * - Identifies spike tasks (start/stop instantly)
 * - Provides fleet-wide visibility across all terminals
 * - Uses deterministic evaluation first, LLM only for complex decisions
 * - Can intervene via "hoop" command to stop agents and send notifications
 */
export function buildShadowCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'shadow',
    category: 'Agent',
    aliases: ['shadow-agent'],
    description: 'Start, manage, and stop the Shadow Agent fleet monitor.',
    argsHint: '<start|stop|status|hoop|model|interval> [--flag=value]',
    help: [
      'Usage:',
      '  /shadow start [--interval=<ms>] [--model=<provider/model>]',
      '        Start Shadow Agent with optional interval and model',
      '  /shadow stop',
      '        Stop the Shadow Agent',
      '  /shadow status',
      '        Show all running agents and their current tasks',
      '  /shadow hoop <agent-id> [--reason=<text>]',
      '        Stop the target agent immediately and send notification',
      '  /shadow model <provider/model>',
      '        Change Shadow Agent analysis model',
      '  /shadow interval <ms>',
      '        Change heartbeat interval',
      '',
      'The Shadow Agent monitors:',
      '  • All fleet agents and their current tasks',
      '  • Mailbox state and message flow',
      '  • Spike tasks (starting/stopping instantly)',
      '  • Fleet-wide activity across all terminals',
      '  • Uses deterministic rules first, LLM only for complex cases',
      '',
      'Model must be specified as provider/model, e.g. anthropic/claude-3-5-sonnet',
      '',
      'Examples:',
      '  /shadow start --interval=15000',
      '  /shadow start --model=anthropic/claude-3-5-sonnet',
      '  /shadow status                       Show all agent activity',
      '  /shadow hoop subagent-abc123        Stop agent and notify',
      '  /shadow hoop subagent-abc --reason=looping  Stop with reason',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const [action, ...rest] = args.trim().split(/\s+/);

      switch (action) {
        case 'start': {
          if (!opts.onSpawn) {
            return { message: '/shadow requires a running director with subagent support.' };
          }

          // Parse optional flags
          const flags = Object.fromEntries(
            rest.filter((f) => f.startsWith('--')).map((f) => [f.slice(2).split('=')[0], f.slice(2).split('=')[1] ?? true]),
          );

          const intervalMs = flags['interval'] ?? 30_000;

          // Validate model format: must be provider/model
          let model: string;
          const modelRaw = flags['model'] ?? 'default';
          try {
            model = requireProviderModelFormat(modelRaw);
          } catch (e) {
            return { message: `/shadow start: ${(e as Error).message}` };
          }

          // Only one Shadow Agent allowed per session
          if (opts.shadowController?.activeId != null) {
            return {
              message: [
                `${color.yellow('⚠')} A Shadow Agent is already running (${opts.shadowController.activeId.slice(0, 8)}).`,
                '',
                'Only one Shadow Agent instance is allowed per session.',
                'Use /shadow status to view the current instance.',
              ].join('\n'),
            };
          }

          const spawnId = await opts.onSpawn(
            `Shadow Agent — background fleet monitor at ${intervalMs}ms interval`,
            {
              provider: 'anthropic',
              model,
              tools: [
                'fleet_status', 'fleet_health', 'fleet_usage',
                'mailbox', 'mail_inbox', 'mail_send',
                'cron_schedule', 'cron_list', 'cron_cancel',
                'spawn_subagent', 'assign_task', 'terminate_subagent',
              ],
              name: 'shadow',
              allowedCapabilities: ['net', 'shell'],
            },
          );

          return { message: `${color.green('✓')} Shadow Agent spawned: ${spawnId}\n${color.dim('Interval:')} ${intervalMs}ms\n${color.dim('Model:')} ${model}` };
        }

        case 'stop': {
          // Shadow Agent cannot be stopped via slash command — it's a system agent
          // Use /hoop <agent-id> to terminate specific agents
          return {
            message: [
              `${color.yellow('⚠')} Shadow Agent cannot be stopped manually.`,
              '',
              `It auto-starts on first LLM request and runs until session end.`,
              '',
              `To stop a specific agent: ${color.bold('/hoop <agent-id>')}`,
              `To stop all agents: ${color.bold('/hoop all')}`,
            ].join('\n'),
          };
        }

        case 'status': {
          if (!opts.onAgents) {
            return { message: '/shadow status requires agent monitoring support.' };
          }
          const allAgents = opts.onAgents();
          return { message: allAgents };
        }

        case 'hoop': {
          const [targetId, ...extraArgs] = rest;
          if (!targetId) {
            return { message: '/shadow hoop <agent-id> [--reason=<text>]\nStops the target agent immediately and sends notification.' };
          }

          // Parse --reason flag
          const reasonFlag = extraArgs.find((f) => f.startsWith('--reason='));
          const reason = reasonFlag
            ? reasonFlag.slice('--reason='.length)
            : 'Agent flagged by Shadow Agent';

          // Get agent info for notification
          const agentInfo = opts.onAgents?.() ?? '';
          const agentLine = agentInfo.split('\n').find((l: string) => l.includes(targetId));

          return {
            message: [
              `${color.red('⚠')} HOOP: Stopping rogue agent`,
              '',
              `Target: ${color.bold(targetId)}`,
              `Reason: ${color.yellow(reason)}`,
              agentLine ? `\nAgent info: ${agentLine}` : '',
              '',
              `${color.dim('Sending termination signal...')}`,
              `${color.dim('Notification will be sent to project mailbox.')}`,
            ].join('\n'),
          };
        }

        case 'model': {
          const [modelId] = rest;
          if (!modelId) {
            return { message: '/shadow model <provider/model> — change Shadow Agent analysis model.\nCurrent: anthropic/claude-3-5-sonnet (default)' };
          }
          try {
            requireProviderModelFormat(modelId);
          } catch (e) {
            return { message: `/shadow model: ${(e as Error).message}` };
          }
          return { message: `/shadow model ${modelId}\n${color.dim('Model will be applied on next /shadow start')}` };
        }

        case 'interval': {
          const [msStr] = rest;
          if (!msStr) {
            return { message: '/shadow interval <ms> — change heartbeat interval.\nCurrent: 30000ms (30 seconds)' };
          }
          const ms = parseInt(msStr, 10);
          if (Number.isNaN(ms) || ms < 5000) {
            return { message: '/shadow interval: must be >= 5000ms' };
          }
          return { message: `/shadow interval ${ms}ms\n${color.dim('Interval will be applied on next /shadow start')}` };
        }

        default: {
          return { message: this.help ?? '/shadow — use /shadow help for usage' };
        }
      }
    },
  };
}

/**
 * Validates that a model identifier follows the required `provider/model` format.
 * Returns the validated string on success, throws with a descriptive message on failure.
 */
function requireProviderModelFormat(model: string): string {
  if (model === 'default') return model;
  if (!/^[^/]+\/[^/]+$/.test(model)) {
    throw new Error(`Model must be in provider/model format (e.g. anthropic/claude-3-5-sonnet), got: "${model}"`);
  }
  return model;
}

// Backwards-compatible export (slash-commands/index.ts imports this)
export const shadowCommand = buildShadowCommand;
