import { expectDefined } from '@wrongstack/core';
/**
 * cost-tracker plugin — Tracks LLM token usage and cost per session.
 *
 * Tools registered:
 * - cost_summary: Show token usage breakdown by model
 * - cost_reset: Reset tracking counters
 * - cost_export: Export cost report as JSON or CSV
 */
import type { Plugin } from '@wrongstack/core';
const API_VERSION = '^0.1.10';

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  timestamp: string;
  costUsd?: number | undefined;
}

interface SessionCost {
  requests: TokenUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { tokens: number; costUsd: number; requests: number }>;
}

// Simple pricing lookup (per 1M tokens). Values are intentionally
// hardcoded — provider-side pricing changes are picked up here per
// release. Users can override per-model via config.extensions
// ['cost-tracker'].pricingOverrides without waiting for a plugin
// version bump (see pricingOverrides handling in setup()).
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 5.0, output: 15.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0 },
  'claude-3-opus': { input: 15.0, output: 75.0 },
  'gemini-1.5-pro': { input: 3.5, output: 10.5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'default': { input: 5.0, output: 15.0 },
};

const DEFAULT_PRICING = { input: 5.0, output: 15.0 };

// Module-level state, shared between `setup`, `teardown`, and `health`.
//
// Why module-level? The Plugin interface in @wrongstack/core does not
// thread state from `setup` → `teardown`. Three reasons these maps need
// module scope:
//   1. `estimateCost()` is called inside the `provider.response` event
//      handler — that handler closes over `pricingOverrides` if we keep
//      it local to setup, but the cleaner pattern (mirroring cron /
//      file-watcher / template-engine / git-autocommit) is module
//      scope so teardown can clear it cleanly on reload.
//   2. The `lastCost` snapshot is for `health()` to report, which
//      needs to survive across the tool boundary.
//   3. The `bundledFromRegistry` map is hydrated from
//      `api.modelsRegistry.load()` on setup; once populated, the
//      `provider.response` event handler reads it synchronously.
//
// Setup re-initializes all three (idempotent re-init on plugin reload);
// teardown clears them and logs.
const pricingOverrides: Record<string, { input: number; output: number }> = {};
const bundledFromRegistry: Record<string, { input: number; output: number }> = {};
const lastCost = { usd: 0, model: null as string | null, at: null as string | null };

interface CostTrackerConfig {
  budgetLimit: number;
  warningThreshold: number;
}

function readCostTrackerConfig(raw: Record<string, unknown> | undefined): CostTrackerConfig {
  return {
    budgetLimit: typeof raw?.['budgetLimit'] === 'number' ? raw['budgetLimit'] : 0,
    warningThreshold: typeof raw?.['warningThreshold'] === 'number' ? raw['warningThreshold'] : 80,
  };
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  // Lookup chain (first hit wins):
  //   1. pricingOverrides[model]   — user-supplied config, highest priority
  //   2. bundledFromRegistry[model] — models.dev catalog (api.modelsRegistry)
  //   3. PRICING[model]             — bundled baseline
  //   4. DEFAULT_PRICING             — fallback for unknown models
  // All keys are normalized to lowercase so all sources match
  // regardless of how the provider reports the model name (gpt-4o
  // vs GPT-4o vs gpt-4O). The registry layer is hydrated once per
  // setup() from a cache file; subsequent reloads come from the same
  // module-scope map.
  const key = model.toLowerCase();
  const pricing =
    pricingOverrides[key] ??
    bundledFromRegistry[key] ??
    PRICING[key] ??
    DEFAULT_PRICING;
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'cost-tracker',
  version: '0.1.0',
  description: 'Tracks LLM token usage and estimated cost per session with per-model breakdown',
  apiVersion: API_VERSION,
  capabilities: { tools: true, pipelines: ['request', 'response'] },
  defaultConfig: {
    trackPerModel: true,
    trackPerUser: false,
    budgetLimit: 0,
    warningThreshold: 80,
    pricingOverrides: {},
  },
  configSchema: {
    type: 'object',
    properties: {
      trackPerModel: { type: 'boolean', default: true },
      trackPerUser: { type: 'boolean', default: false },
      budgetLimit: { type: 'number', default: 0, description: 'Budget limit in USD (0 = no limit)' },
      warningThreshold: { type: 'number', default: 80, description: 'Warning threshold as percentage of budget' },
      pricingOverrides: {
        type: 'object',
        description: 'Per-model pricing overrides in USD per 1M tokens. Keys are lowercased model names; values are { input, output }. Takes precedence over the bundled PRICING table.',
        additionalProperties: {
          type: 'object',
          properties: {
            input: { type: 'number', minimum: 0, description: 'Cost per 1M input tokens in USD' },
            output: { type: 'number', minimum: 0, description: 'Cost per 1M output tokens in USD' },
          },
          required: ['input', 'output'],
          additionalProperties: false,
        },
        default: {},
      },
    },
  },

  setup(api) {
    // Idempotent re-init: clear any overrides that survived a previous
    // teardown, then apply the user-supplied ones. Mirroring the
    // template-engine / git-autocommit / cron / file-watcher pattern.
    // Reassignment of a module-level const... actually we declared
    // pricingOverrides as a `const` reference with a mutable inner
    // shape — so clear the keys instead of reassigning.
    for (const k of Object.keys(pricingOverrides)) {
      delete pricingOverrides[k];
    }
    for (const k of Object.keys(bundledFromRegistry)) {
      delete bundledFromRegistry[k];
    }
    lastCost.usd = 0;
    lastCost.model = null;
    lastCost.at = null;

    // Hydrate `bundledFromRegistry` from the host's models registry if
    // one is provided. The registry's `load()` is cached (subsequent
    // calls are in-memory) and returns the models.dev payload. We
    // flatten it into a lowercase-keyed { input, output } map. On any
    // failure (no network, no cache, no model entries) we log a
    // warning and proceed with the bundled PRICING table as the
    // baseline — the lookup chain's other layers still cover
    // common models.
    if (api.modelsRegistry) {
      void (async () => {
        try {
          const payload = await api.modelsRegistry!.load();
          let hydrated = 0;
          for (const provider of Object.values(payload)) {
            const providerModels = provider?.models;
            if (!providerModels) continue;
            for (const [modelId, model] of Object.entries(providerModels)) {
              const cost = model?.cost;
              if (
                cost &&
                typeof cost.input === 'number' &&
                typeof cost.output === 'number'
              ) {
                bundledFromRegistry[modelId.toLowerCase()] = {
                  input: cost.input,
                  output: cost.output,
                };
                hydrated += 1;
              }
            }
          }
          api.log.info('cost-tracker: hydrated pricing from models registry', {
            models: hydrated,
          });
        } catch (err) {
          // Defensive: a broken or absent registry must not break
          // cost-tracking. The lookup chain falls through to PRICING.
          api.log.warn(
            'cost-tracker: failed to hydrate pricing from models registry — using bundled PRICING',
            err,
          );
        }
      })();
    }

    const rawConfig = api.config.extensions?.['cost-tracker'] as
      | Record<string, unknown>
      | undefined;
    const userOverrides = rawConfig?.['pricingOverrides'];
    if (userOverrides && typeof userOverrides === 'object') {
      for (const [model, value] of Object.entries(userOverrides as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        const input = v['input'];
        const output = v['output'];
        if (typeof input !== 'number' || typeof output !== 'number') continue;
        // Lowercase keys so user-supplied entries match the same
        // case-insensitive lookup that estimateCost uses.
        pricingOverrides[model.toLowerCase()] = { input, output };
      }
    }

    // Track token usage per request across the response pipeline
    const sessionCost: SessionCost = {
      requests: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      byModel: {},
    };

    // Subscribe to provider.response events to capture token usage
    api.onEvent('provider.response', (payload) => {
      const usage = payload.usage;
      const model = payload.ctx?.model ?? 'unknown';

      const promptTokens = usage.input ?? 0;
      const completionTokens = usage.output ?? 0;
      const totalTokens = promptTokens + completionTokens;
      const costUsd = estimateCost(model, promptTokens, completionTokens);

      const record: TokenUsage = {
        promptTokens,
        completionTokens,
        totalTokens,
        model,
        timestamp: new Date().toISOString(),
        costUsd,
      };

      sessionCost.requests.push(record);
      sessionCost.totalPromptTokens += promptTokens;
      sessionCost.totalCompletionTokens += completionTokens;
      sessionCost.totalTokens += totalTokens;
      sessionCost.totalCostUsd += costUsd;

      if (sessionCost.byModel[model] === undefined) {
        sessionCost.byModel[model] = { tokens: 0, costUsd: 0, requests: 0 };
      }
      const slot = expectDefined(sessionCost.byModel[model]);
      slot.tokens += totalTokens;
      slot.costUsd += costUsd;
      slot.requests += 1;

      api.metrics.counter('tokens_total', totalTokens, { model });
      api.metrics.histogram('cost_usd', costUsd, { model });

      // Snapshot for /diag plugins (health()).
      lastCost.usd = costUsd;
      lastCost.model = model;
      lastCost.at = new Date().toISOString();
    });

    // --- cost_summary tool ---
    api.tools.register({
      name: 'cost_summary',
      description: 'Returns the current session\'s token usage breakdown by model, total cost estimate, and budget status.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Meta',
      mutating: false,
      async execute() {
        const { budgetLimit, warningThreshold } = readCostTrackerConfig(
          api.config.extensions?.['cost-tracker'],
        );

        const usage = {
          totalRequests: sessionCost.requests.length,
          totalPromptTokens: sessionCost.totalPromptTokens,
          totalCompletionTokens: sessionCost.totalCompletionTokens,
          totalTokens: sessionCost.totalTokens,
          totalCostUsd: Math.round(sessionCost.totalCostUsd * 1_000_000) / 1_000_000,
          byModel: sessionCost.byModel,
          recentRequests: sessionCost.requests.slice(-5).map((r) => ({
            model: r.model,
            tokens: r.totalTokens,
            costUsd: r.costUsd,
            ts: r.timestamp,
          })),
        };

        const budgetStatus = budgetLimit > 0
          ? {
              limit: budgetLimit,
              spent: sessionCost.totalCostUsd,
              percentUsed: Math.round((sessionCost.totalCostUsd / budgetLimit) * 100),
              warning: sessionCost.totalCostUsd / budgetLimit * 100 >= warningThreshold,
            }
          : null;

        return {
          ok: true,
          usage,
          budgetStatus,
        };
      },
    });

    // --- cost_reset tool ---
    api.tools.register({
      name: 'cost_reset',
      description: 'Resets all token usage and cost counters for the current session.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: true,
      async execute() {
        const prev = {
          totalTokens: sessionCost.totalTokens,
          totalCostUsd: sessionCost.totalCostUsd,
        };

        sessionCost.requests = [];
        sessionCost.totalPromptTokens = 0;
        sessionCost.totalCompletionTokens = 0;
        sessionCost.totalTokens = 0;
        sessionCost.totalCostUsd = 0;
        sessionCost.byModel = {};

        return {
          ok: true,
          previousTotals: prev,
          message: 'Cost tracking counters have been reset.',
        };
      },
    });

    // --- cost_export tool ---
    api.tools.register({
      name: 'cost_export',
      description: 'Export the cost report as JSON or CSV.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
          includeModel: { type: 'boolean', default: true },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const format = (input['format'] as 'json' | 'csv') ?? 'json';
        const includeModel = (input['includeModel'] as boolean) ?? true;

        if (format === 'csv') {
          const header = includeModel
            ? 'model,timestamp,prompt_tokens,completion_tokens,total_tokens,cost_usd'
            : 'timestamp,prompt_tokens,completion_tokens,total_tokens,cost_usd';
          const rows = sessionCost.requests.map((r) => {
            /* v8 ignore next -- costUsd is always set by estimateCost; the ?? 0 fallback is defensive. */
            const cost = r.costUsd ?? 0;
            return includeModel
              ? `${r.model},${r.timestamp},${r.promptTokens},${r.completionTokens},${r.totalTokens},${cost}`
              : `${r.timestamp},${r.promptTokens},${r.completionTokens},${r.totalTokens},${cost}`;
          });
          return {
            ok: true,
            format: 'csv',
            data: [header, ...rows].join('\n'),
            summary: {
              totalTokens: sessionCost.totalTokens,
              totalCostUsd: sessionCost.totalCostUsd,
              totalRequests: sessionCost.requests.length,
            },
          };
        }

        return {
          ok: true,
          format: 'json',
          data: {
            summary: {
              totalTokens: sessionCost.totalTokens,
              totalPromptTokens: sessionCost.totalPromptTokens,
              totalCompletionTokens: sessionCost.totalCompletionTokens,
              totalCostUsd: sessionCost.totalCostUsd,
              totalRequests: sessionCost.requests.length,
              byModel: sessionCost.byModel,
            },
            requests: includeModel
              ? sessionCost.requests
              : sessionCost.requests.map(({ promptTokens, completionTokens, totalTokens, costUsd, timestamp }) => ({
                  promptTokens, completionTokens, totalTokens, costUsd, timestamp,
                })),
          },
        };
      },
    });

    // Write cost data to session log on shutdown
    api.onEvent('session.ended', async () => {
      if (sessionCost.requests.length > 0) {
        await api.session.append({
          type: 'cost-tracker:session_summary',
          ts: new Date().toISOString(),
          totalTokens: sessionCost.totalTokens,
          totalCostUsd: sessionCost.totalCostUsd,
          totalRequests: sessionCost.requests.length,
          byModel: sessionCost.byModel,
        });
      }
    });

    api.log.info('cost-tracker plugin loaded', { version: '0.1.0' });
  },

  teardown(api) {
    // Mirror of the H1 pattern: clear module-scope state on unload so
    // the next setup() starts fresh and a reload cycle doesn't
    // accumulate stale overrides, registry snapshots, or last-cost
    // entries.
    const overrideCount = Object.keys(pricingOverrides).length;
    const registryCount = Object.keys(bundledFromRegistry).length;
    for (const k of Object.keys(pricingOverrides)) {
      delete pricingOverrides[k];
    }
    for (const k of Object.keys(bundledFromRegistry)) {
      delete bundledFromRegistry[k];
    }
    const finalLast = { ...lastCost };
    lastCost.usd = 0;
    lastCost.model = null;
    lastCost.at = null;
    api.log.info('cost-tracker: teardown complete', {
      overrideCount,
      registryCount,
      lastModel: finalLast.model,
    });
  },

  async health() {
    // /diag plugins wants a quick yes/no plus context. We surface:
    //   - override count (so operators can confirm their pricingOverrides
    //     were applied without grepping config)
    //   - the last cost we recorded (so a fresh diag right after a
    //     request confirms the wiring is alive)
    // Note: session totals are *not* reported here — they live inside
    // the setup() closure (sessionCost) and are exposed via the
    // cost_summary tool instead. health() is module-scope only.
    return {
      ok: true,
      message:
        lastCost.model === null
          ? 'cost-tracker: no requests recorded yet this session'
          : `cost-tracker: last ${lastCost.model} cost=${lastCost.usd.toFixed(6)} at ${lastCost.at}`,
      overrideCount: Object.keys(pricingOverrides).length,
      registryCount: Object.keys(bundledFromRegistry).length,
      lastCostUsd: lastCost.usd,
      lastCostModel: lastCost.model,
      lastCostAt: lastCost.at,
    };
  },
};

export default plugin;
