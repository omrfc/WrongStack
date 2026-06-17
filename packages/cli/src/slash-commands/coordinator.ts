import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildCoordinatorCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'coordinator',
    category: 'Agent',
    description:
      'Start, stop, or inspect the AutonomousCoordinator — the fleet brain that auctions tasks and consults Brain for risky decisions.',
    help: [
      'Usage:',
      '  /coordinator start <goal>   Start the coordinator with a goal',
      '  /coordinator stop           Stop the running coordinator',
      '  /coordinator status         Show current coordinator status',
      '',
      'The AutonomousCoordinator runs alongside the agent loop and:',
      '  • Maintains a shared knowledge graph of facts and decisions',
      '  • Breaks work into a task DAG and auctions tasks to subagents',
      '  • Consults the Brain for risky decisions',
      '  • Uses ConsensusProtocol to vote on multi-agent changes',
      '',
      'It is separate from /autonomy eternal — both can run concurrently.',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim();
      const [verbRaw, ...rest] = trimmed.split(/\s+/);
      const verb = (verbRaw ?? '').toLowerCase();

      if (verb === 'start') {
        const goal = rest.join(' ').trim();
        if (!goal) {
          return { message: 'Usage: /coordinator start <goal>\nA goal is required to start the coordinator.' };
        }
        opts.onCoordinatorStart?.(goal);
        return {
          message: `AutonomousCoordinator started with goal: "${goal}"\nUse /coordinator status to monitor progress.`,
        };
      }

      if (verb === 'stop') {
        opts.onCoordinatorStop?.();
        return { message: 'AutonomousCoordinator stop signal sent.' };
      }

      if (verb === 'status') {
        // Status is available through the TUI's coordinator panel (F9 → Coordinator tab).
        const canStart = opts.onCoordinatorStart != null;
        const canStop = opts.onCoordinatorStop != null;
        return {
          message: [
            `Coordinator wired: start=${canStart ? 'yes' : 'no'}, stop=${canStop ? 'yes' : 'no'}`,
            'Use F9 in the TUI for the full coordinator panel.',
          ].join('\n'),
        };
      }

      return {
        message: [
          'Usage:',
          '  /coordinator start <goal>   Start with a goal',
          '  /coordinator stop            Stop the coordinator',
          '  /coordinator status          Show status',
          '',
          'The coordinator is a fleet brain that:',
          '  • Auctions tasks to subagents via TaskAuctioneer',
          '  • Maintains a shared KnowledgeGraph',
          '  • Consults Brain for risky decisions',
          '  • Uses ConsensusProtocol for multi-agent votes',
        ].join('\n'),
      };
    },
  };
}
