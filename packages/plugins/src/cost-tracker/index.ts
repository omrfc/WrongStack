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

// Simple pricing lookup (per 1M tokens)
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
  const pricing = PRICING[model.toLowerCase()] ?? DEFAULT_PRICING;
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
  },
  configSchema: {
    type: 'object',
    properties: {
      trackPerModel: { type: 'boolean', default: true },
      trackPerUser: { type: 'boolean', default: false },
      budgetLimit: { type: 'number', default: 0, description: 'Budget limit in USD (0 = no limit)' },
      warningThreshold: { type: 'number', default: 80, description: 'Warning threshold as percentage of budget' },
    },
  },

  setup(api) {
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
    });

    // --- cost_summary tool ---
    api.tools.register({
      name: 'cost_summary',
      description: 'Returns the current session\'s token usage breakdown by model, total cost estimate, and budget status.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
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
};

export default plugin;
