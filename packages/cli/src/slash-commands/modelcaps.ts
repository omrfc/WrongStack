import * as fs from 'node:fs/promises';
import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * `/modelcaps` — enumerate available models with their capabilities
 * (context window, max output, pricing) across all configured providers.
 *
 * Reads from `~/.wrongstack/cache/models.dev.json` (the same cache used
 * by the models registry). Falls back gracefully if the cache is missing
 * or unreadable.
 *
 * Subcommands:
 *   (none)        List all available models grouped by provider.
 *   <provider>    Show models for one provider only.
 *   <fragment>    Filter models whose id contains the fragment.
 *   summary       Show agent-type → model mapping (delegates to /setmodel).
 */

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtPrice(pricePer1k: number | undefined): string {
  if (pricePer1k === undefined || pricePer1k <= 0) return color.dim('—');
  return `$${pricePer1k.toFixed(2)}/M tok`;
}

function contextBar(maxContext: number): string {
  const emoji = maxContext > 200_000 ? '🟢' : maxContext > 128_000 ? '🟡' : '🔴';
  return `${emoji} ${fmtTokens(maxContext)}`;
}

interface CacheModel {
  id: string;
  name?: string | undefined;
  capabilities?: { contextWindow?: number | undefined; maxOutputTokens?: number | undefined } | undefined;
  pricing?: { input?: number; output?: number } | undefined;
}

interface CacheProvider {
  id: string;
  name: string;
  family: string;
  models?: CacheModel[];
}

export function buildModelCapsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'modelcaps',
    category: 'Config',
    description: 'List available models with capacities (context window, max output, pricing).',
    help: [
      'Usage:',
      '  /modelcaps                     List all available models grouped by provider',
      '  /modelcaps <provider>          Show models for one provider only',
      '  /modelcaps <fragment>          Filter models by id fragment (case-insensitive)',
      '  /modelcaps summary             Show agent-type → model mapping matrix',
      '',
      'Capacities shown: context window, max output tokens, input/output pricing.',
      '● = API key present · ○ = no key (model listed but not usable).',
    ].join('\n'),

    async run(args) {
      const trimmed = args.trim().toLowerCase();

      // ── Summary: agent-type → model mapping ──
      if (trimmed === 'summary') {
        return {
          message: [
            `${color.bold('Agent-Type → Model Mapping')} ${color.dim('— use /setmodel')}`,
            '',
            `${color.dim('Run /setmodel to see the current model matrix and resolution chain.')}`,
            `${color.dim('Each agent role resolves its model via: role → phase → * → leader.')}`,
            '',
            `${color.dim('/setmodel         — show leader + matrix + resolution summary')}`,
            `${color.dim('/setmodel resolve <role> — walk the resolution chain for one role')}`,
          ].join('\n'),
        };
      }

      // ── Load models cache ──
      const cachePath = opts.paths?.modelsCache;
      if (!cachePath) {
        return { message: `${color.red('Models cache path not available')}.` };
      }

      let providers: CacheProvider[];
      try {
        const raw = await fs.readFile(cachePath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // The cache file is a CacheEnvelope: { fetchedAt, url, payload: Record<id, ModelsDevProvider> }.
        // Extract the payload (if enveloped) and convert the provider-object to an array.
        const payload = ((parsed.payload ?? parsed) as Record<string, Record<string, unknown>>);
        providers = Object.entries(payload).map(([id, p]) => ({
          id: (p.id as string) ?? id,
          name: (p.name as string) ?? id,
          family: (p.npm as string) ?? id,
          models: Object.values((p.models as Record<string, Record<string, unknown>>) ?? {}).map((m) => ({
            id: m.id as string,
            name: m.name as string | undefined,
            capabilities: {
              contextWindow: (m.limit as { context?: number } | undefined)?.context,
              maxOutputTokens: (m.limit as { output?: number } | undefined)?.output,
            },
            pricing: m.cost as { input?: number; output?: number } | undefined,
          })),
        }));
      } catch {
        return {
          message: [
            `${color.amber('Models cache not available')}.`,
            `${color.dim(`Expected at: ${cachePath}`)}`,
            '',
            `${color.dim('Run wstack sync-models or wait for the next auto-sync.')}`,
          ].join('\n'),
        };
      }

      const config = opts.configStore.get();
      const configProviders = (config?.providers ?? {}) as Record<string, { apiKey?: string; apiKeys?: Array<{ apiKey?: string }> }>;

      function hasKey(providerId: string): boolean {
        const pc = configProviders[providerId];
        if (!pc) return false;
        if (typeof pc.apiKey === 'string' && pc.apiKey.length > 0) return true;
        if (Array.isArray(pc.apiKeys) && pc.apiKeys.some((k) => k?.apiKey)) return true;
        return false;
      }

      const lines: string[] = [
        `${color.bold('Available Models')} ${color.dim('— capacities + pricing')}`,
        '',
      ];

      let shown = 0;

      for (const prov of providers) {
        // Filter by provider if user specified a fragment without slash
        if (trimmed && !trimmed.includes('/') && !prov.id.toLowerCase().includes(trimmed) && !prov.name.toLowerCase().includes(trimmed)) {
          continue;
        }

        const keyed = hasKey(prov.id);
        const marker = keyed ? color.green('●') : color.dim('○');

        lines.push(`  ${marker} ${color.bold(prov.id.padEnd(16))} ${color.dim(`(${prov.name})`)}`);

        const models = prov.models ?? [];
        if (models.length === 0) {
          lines.push(`    ${color.dim('no models listed — any model id accepted')}`);
        }

        for (const m of models) {
          // Per-model fragment filter (after / in the filter string)
          if (trimmed?.includes('/')) {
            const frag = trimmed.split('/').pop() ?? '';
            if (frag && !m.id.toLowerCase().includes(frag)) continue;
          }

          const cap = m.capabilities;
          const ctx = cap?.contextWindow ?? 0;
          const maxOut = cap?.maxOutputTokens ?? 0;

          lines.push(
            `    ${color.cyan(m.id)}  ` +
            `${contextBar(ctx)}` +
            (maxOut > 0 ? ` ${color.dim('out')} ${fmtTokens(maxOut)}` : '') +
            `  ${color.dim('in')} ${fmtPrice(m.pricing?.input)}  ${color.dim('out')} ${fmtPrice(m.pricing?.output)}`,
          );
          shown++;
        }
        lines.push('');
      }

      if (shown === 0) {
        lines.push(`  ${color.dim('No models matched. Try /modelcaps without a filter.')}`);
      }

      lines.push(color.dim(`${shown} model(s). ● = key present · ○ = no key. Use /modelcaps summary for agent-type mapping.`));
      return { message: lines.join('\n') };
    },
  };
}
