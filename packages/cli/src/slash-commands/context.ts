import {
  color,
  formatContextWindowModeList,
  getContextWindowMode,
  resolveContextWindowPolicy,
  type ContextWindowPolicy,
} from '@wrongstack/core';
import type { Context, SlashCommand } from '@wrongstack/core';
import { countToolResults, countToolUses, countTurnPairs, estimateTokens } from './helpers.js';
import type { SlashCommandContext } from './index.js';

export function buildContextCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'context',
    aliases: ['ctx'],
    description: 'Show context window summary.',
    help: [
      'Usage:',
      '  /context           Show counts: messages, est. tokens, tool calls, todos, read files.',
      '  /context detail    As above, plus model, cwd, projectRoot, and the file list.',
      '  /context mode      List context-window modes.',
      '  /context mode <id> Switch context-window mode for this session.',
    ].join('\n'),
    async run(args, ctx) {
      const trimmed = args.trim();

      if (trimmed === 'mode' || trimmed === 'modes') {
        const active = readPolicy(ctx)?.id ?? 'balanced';
        const msg = `${color.bold('Context Window Modes')}\n${formatContextWindowModeList(active)}`;
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed.startsWith('mode ')) {
        const id = trimmed.slice('mode '.length).trim();
        const mode = getContextWindowMode(id);
        if (!mode) {
          const msg = `Unknown context mode "${id}". Use /context mode to list modes.`;
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        const policy = resolveContextWindowPolicy({}, mode.id);
        ctx.meta['contextWindowMode'] = policy.id;
        ctx.meta['contextWindowPolicy'] = policy;
        const msg = [
          `${color.green('Context mode set:')} ${policy.id} (${policy.name})`,
          `  thresholds: warn ${pct(policy.thresholds.warn)}, soft ${pct(policy.thresholds.soft)}, hard ${pct(policy.thresholds.hard)}`,
          `  preserve:   last ${policy.preserveK} user/assistant messages`,
          `  elide:      old tool results >= ${policy.eliseThreshold.toLocaleString()} tokens`,
        ].join('\n');
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      const messages = ctx.messages;
      const detailed = trimmed === 'detail';
      const policy = readPolicy(ctx);
      const lines = [
        `${color.bold('Context Window')}`,
        `  messages:    ${messages.length} total (${countTurnPairs(messages)} user+assistant pairs)`,
        `  tokens (est): ${estimateTokens(messages).toLocaleString()} (chars / 4 estimate)`,
        `  mode:        ${policy ? `${policy.id} (${policy.name})` : 'balanced'}`,
        `  system prompt: ${ctx.systemPrompt.length} block${ctx.systemPrompt.length !== 1 ? 's' : ''}`,
        `  tools:       ${countToolUses(messages)} calls made, ${countToolResults(messages)} results in history`,
        `  read files:  ${ctx.readFiles.size} files`,
        `  todos:       ${ctx.todos.filter((t) => t.status === 'in_progress').length} in_progress / ${ctx.todos.filter((t) => t.status === 'pending').length} pending / ${ctx.todos.filter((t) => t.status === 'completed').length} completed`,
      ];
      if (detailed) {
        lines.push(
          `  thresholds:  warn ${pct(policy?.thresholds.warn ?? 0.6)}, soft ${pct(policy?.thresholds.soft ?? 0.75)}, hard ${pct(policy?.thresholds.hard ?? 0.9)}`,
          `  model:       ${ctx.model}`,
          `  cwd:         ${ctx.cwd}`,
          `  projectRoot: ${ctx.projectRoot}`,
          `  file mtimes: ${ctx.fileMtimes.size} tracked`,
        );
        if (ctx.readFiles.size > 0) lines.push(`  file list:   ${[...ctx.readFiles].join(', ')}`);
      }
      const msg = lines.join('\n');
      opts.renderer.write(`${msg}\n`);
      return { message: msg };
    },
  };
}

function readPolicy(ctx: Context): ContextWindowPolicy | null {
  const policy = ctx.meta?.['contextWindowPolicy'];
  return policy && typeof policy === 'object' ? (policy as ContextWindowPolicy) : null;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
