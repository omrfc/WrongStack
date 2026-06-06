import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildCompactCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'compact',
    category: 'Session',
    description: 'Compact the context window.',
    help: [
      'Usage:',
      '  /compact              Run the configured compactor with default settings.',
      '  /compact aggressive   Compact more aggressively.',
      '',
      'The compactor summarizes older turns to reclaim tokens.',
    ].join('\n'),
    async run(args, ctx) {
      if (!opts.compactor) {
        const msg = 'No compactor configured.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }
      const aggressive = args.trim() === 'aggressive';
      const report = await opts.compactor.compact(ctx, { aggressive });
      const reductions = report.reductions
        .map((r: { phase: string; saved: number }) => `${r.phase}: ${r.saved}`)
        .join(', ');
      const repaired = report.repaired
        ? `; repaired ${report.repaired.removedToolUses.length} tool_use, ${report.repaired.removedToolResults.length} tool_result, ${report.repaired.removedMessages} empty messages`
        : '';
      const msg = `Compaction: ${report.before} -> ${report.after} tokens (${reductions})${repaired}`;
      opts.renderer.writeInfo(msg);
      return { message: msg };
    },
  };
}
