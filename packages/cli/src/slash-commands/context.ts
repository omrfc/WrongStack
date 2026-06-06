import * as fs from 'node:fs/promises';
import {
  atomicWrite,
  color,
  formatContextWindowModeList,
  getContextWindowMode,
  repairToolUseAdjacency,
  resolveContextWindowPolicy,
  type ContextWindowPolicy,
} from '@wrongstack/core';
import type { Config, Context, SlashCommand } from '@wrongstack/core';
import { countToolResults, countToolUses, countTurnPairs, estimateTokens } from './helpers.js';
import type { SlashCommandContext } from './index.js';

export function buildContextCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'context',
    category: 'Inspect',
    aliases: ['ctx'],
    description: 'Show context window summary.',
    help: [
      'Usage:',
      '  /context           Show counts: messages, est. tokens, tool calls, todos, read files.',
      '  /context detail    As above, plus model, cwd, projectRoot, and the file list.',
      '  /context repair    Repair orphan tool_use/tool_result blocks after manual compaction.',
      '  /context limit     Show effective context window for this session.',
      '  /context limit <tokens> Set effective context window for this session (e.g. 220k).',
      '  /context limit <tokens> --persist Persist effective context window to config.',
      '  /context thresholds <warn> <soft> <hard> Set compaction thresholds (percent or decimal).',
      '  /context thresholds <warn> <soft> <hard> --persist Persist thresholds to config.',
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

      if (trimmed === 'repair') {
        const before = ctx.messages.length;
        const repaired = repairToolUseAdjacency(ctx.messages);
        if (repaired.report.changed) {
          ctx.state.replaceMessages(repaired.messages);
        }
        const msg = repaired.report.changed
          ? [
              `${color.green('Context repaired')}`,
              `  messages:     ${before} -> ${ctx.messages.length}`,
              `  tool_use:     removed ${repaired.report.removedToolUses.length}`,
              `  tool_result:  removed ${repaired.report.removedToolResults.length}`,
              `  empty msgs:   removed ${repaired.report.removedMessages}`,
            ].join('\n')
          : 'Context repair: no orphan tool_use/tool_result blocks found.';
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed === 'limit') {
        const limit = readEffectiveLimit(ctx, opts);
        const msg = limit > 0
          ? `Effective context window: ${limit.toLocaleString()} tokens`
          : 'Effective context window: unknown (auto-compaction may be disabled).';
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed.startsWith('limit ')) {
        const persist = hasPersistFlag(trimmed);
        const raw = stripPersistFlag(trimmed.slice('limit '.length)).trim();
        const limit = parseTokenCount(raw);
        if (!limit) {
          const msg = `Invalid context limit "${raw}". Use a positive token count, e.g. 220k or 220000.`;
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        ctx.meta['effectiveMaxContext'] = limit;
        const effective = opts.onContextLimit?.(limit) ?? limit;
        if (persist) {
          const error = await persistContextConfig(opts, { effectiveMaxContext: limit });
          if (error) {
            opts.renderer.write(`${color.red(error)}\n`);
            return { message: error };
          }
        }
        const msg = `${color.green('Effective context window set:')} ${effective.toLocaleString()} tokens${persist ? ' (persisted)' : ''}`;
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed.startsWith('thresholds ')) {
        const persist = hasPersistFlag(trimmed);
        const thresholdArgs = stripPersistFlag(trimmed.slice('thresholds '.length)).trim();
        const parts = thresholdArgs.split(/\s+/).filter(Boolean);
        if (parts.length !== 3) {
          const msg = 'Usage: /context thresholds <warn> <soft> <hard> (examples: 60% 75% 90% or 0.6 0.75 0.9)';
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        const thresholds = parts.map(parseThreshold);
        if (thresholds.some((v): v is null => v === null)) {
          const msg = 'Invalid thresholds. Use percentages (60%) or decimals between 0 and 1.';
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        const [warn, soft, hard] = thresholds as [number, number, number];
        if (!(warn < soft && soft < hard)) {
          const msg = 'Invalid thresholds: require warn < soft < hard.';
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        const base = readPolicy(ctx) ?? resolveContextWindowPolicy({});
        const policy = { ...base, thresholds: { warn, soft, hard } };
        ctx.meta['contextWindowMode'] = policy.id;
        ctx.meta['contextWindowPolicy'] = policy;
        if (persist) {
          const error = await persistContextConfig(opts, {
            warnThreshold: warn,
            softThreshold: soft,
            hardThreshold: hard,
          });
          if (error) {
            opts.renderer.write(`${color.red(error)}\n`);
            return { message: error };
          }
        }
        const msg = `${color.green('Context thresholds set:')} warn ${pct(warn)}, soft ${pct(soft)}, hard ${pct(hard)}${persist ? ' (persisted)' : ''}`;
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
        `  limit:       ${formatLimit(readEffectiveLimit(ctx, opts))}`,
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

function hasPersistFlag(input: string): boolean {
  return /(?:^|\s)--persist(?:\s|$)/.test(input);
}

function stripPersistFlag(input: string): string {
  return input.replace(/(?:^|\s)--persist(?:\s|$)/g, ' ').trim();
}

async function persistContextConfig(
  opts: SlashCommandContext,
  patch: Partial<Config['context']>,
): Promise<string | null> {
  if (!opts.configStore || !opts.paths) return 'Cannot persist context settings: config store not available.';

  let raw = '{}';
  try {
    raw = await fs.readFile(opts.paths.globalConfig, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `Could not read ${opts.paths.globalConfig}: ${(err as Error).message}`;
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return `Config at ${opts.paths.globalConfig} is not valid JSON: ${(err as Error).message}`;
  }

  const current = opts.configStore.get();
  const context = {
    ...(current.context as Config['context']),
    ...((parsed.context as Partial<Config['context']> | undefined) ?? {}),
    ...patch,
  };
  parsed.context = context;
  await atomicWrite(opts.paths.globalConfig, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  opts.configStore.update({ context });
  return null;
}

function readEffectiveLimit(ctx: Context, opts: SlashCommandContext): number {
  const live = opts.onContextLimit?.();
  if (typeof live === 'number' && Number.isFinite(live) && live > 0) return live;
  const metaLimit = ctx.meta?.['effectiveMaxContext'];
  if (typeof metaLimit === 'number' && Number.isFinite(metaLimit) && metaLimit > 0) return metaLimit;
  const providerLimit = ctx.provider?.capabilities?.maxContext;
  return typeof providerLimit === 'number' && Number.isFinite(providerLimit) && providerLimit > 0
    ? providerLimit
    : 0;
}

function parseTokenCount(raw: string): number | null {
  const normalized = raw.trim().toLowerCase().replace(/,/g, '').replace(/_/g, '');
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(normalized);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const scaled = unit === 'm' ? value * 1_000_000 : unit === 'k' ? value * 1_000 : value;
  const rounded = Math.floor(scaled);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
}

function parseThreshold(raw: string): number | null {
  const s = raw.trim();
  const percent = s.endsWith('%');
  const n = Number((percent ? s.slice(0, -1) : s).trim());
  if (!Number.isFinite(n)) return null;
  const value = percent ? n / 100 : n;
  return value > 0 && value < 1 ? value : null;
}

function formatLimit(limit: number): string {
  return limit > 0 ? `${limit.toLocaleString()} tokens` : 'unknown';
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
