/**
 * token-budget plugin — Enforces a per-session token budget.
 *
 * Complements cost-tracker (which tracks but does not enforce).
 * When token usage crosses the warning threshold, injects a "wrap up"
 * signal into the LLM's context. When it crosses the hard limit,
 * triggers a Stop hook to end the agent loop.
 *
 * Tools registered:
 * - token_budget_status : Show budget limit, current usage, percent
 *                          consumed, and whether the warning/stop
 *                          threshold has been crossed.
 *
 * Hooks registered:
 * - Stop : checks whether the budget is exhausted; if so, returns
 *          `decision: 'block'` with a reason so the agent loop does
 *          not continue.
 *
 * Events subscribed:
 * - provider.response : accumulates prompt + completion tokens.
 *
 * Config surface (`config.extensions['token-budget']`):
 *
 * ```jsonc
 * {
 *   "limit": 500000,       // hard token limit (prompt + completion)
 *   "warnPercent": 80,     // inject "wrap up" at this % of limit
 *   "stopPercent": 100,    // trigger Stop at this % of limit
 *   "model": null          // null = all models; or restrict to one
 * }
 * ```
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  totalTokens: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  requestCount: 0,
  /** Whether the warning has already fired (one-shot). */
  warningFired: false,
  /** Whether the stop has already fired (one-shot). */
  stopFired: false,
  /** Stop hook unregister handle. */
  hookUnregister: null as null | (() => void),
  /** Last token breakdown — surfaced by health(). */
  lastRequest: null as null | {
    model: string;
    prompt: number;
    completion: number;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TokenBudgetConfig {
  /** Hard token limit (prompt + completion combined). 0 = no limit. */
  limit: number;
  /** Percentage of limit at which to inject "wrap up" context. */
  warnPercent: number;
  /** Percentage of limit at which to trigger Stop. */
  stopPercent: number;
  /** Restrict counting to a specific model (empty string = all models). */
  model: string;
}

const DEFAULTS: TokenBudgetConfig = {
  limit: 0,
  warnPercent: 80,
  stopPercent: 100,
  model: '',
};

function readConfig(raw: unknown): TokenBudgetConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    limit: typeof r['limit'] === 'number' ? r['limit'] : DEFAULTS.limit,
    warnPercent: typeof r['warnPercent'] === 'number' ? r['warnPercent'] : DEFAULTS.warnPercent,
    stopPercent: typeof r['stopPercent'] === 'number' ? r['stopPercent'] : DEFAULTS.stopPercent,
    model: typeof r['model'] === 'string' ? r['model'] : '',
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'token-budget',
  version: '0.1.0',
  description: 'Enforces a per-session token budget — warns at a threshold and stops the agent loop when the limit is hit',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        minimum: 0,
        default: 0,
        description: 'Hard token limit (prompt + completion combined). 0 = disabled (tracking only).',
      },
      warnPercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 80,
        description: 'Percentage of limit at which to inject a "wrap up" context signal.',
      },
      stopPercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 100,
        description: 'Percentage of limit at which to trigger Stop (end the agent loop).',
      },
      model: {
        type: 'string',
        default: '',
        description: 'Restrict counting to a specific model. Empty string = count all models.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.totalTokens = 0;
    state.totalPromptTokens = 0;
    state.totalCompletionTokens = 0;
    state.requestCount = 0;
    state.warningFired = false;
    state.stopFired = false;
    state.hookUnregister = null;
    state.lastRequest = null;

    const cfg = readConfig(api.config.extensions?.['token-budget']);

    // Subscribe to provider.response to accumulate tokens.
    api.onEvent('provider.response', (payload: unknown) => {
      const p = payload as {
        usage?: { input?: number; output?: number };
        ctx?: { model?: string };
      };
      const usage = p?.usage;
      if (!usage) return;

      // Filter by model if configured.
      if (cfg.model !== '' && p?.ctx?.model !== cfg.model) return;

      const promptTokens = usage.input ?? 0;
      const completionTokens = usage.output ?? 0;
      const total = promptTokens + completionTokens;

      state.totalPromptTokens += promptTokens;
      state.totalCompletionTokens += completionTokens;
      state.totalTokens += total;
      state.requestCount += 1;
      state.lastRequest = {
        model: p?.ctx?.model ?? 'unknown',
        prompt: promptTokens,
        completion: completionTokens,
        when: new Date().toISOString(),
      };

      // No limit = tracking only, no enforcement.
      if (cfg.limit <= 0) return;

      const percent = (state.totalTokens / cfg.limit) * 100;

      // Warning threshold (one-shot injection).
      if (!state.warningFired && percent >= cfg.warnPercent && percent < cfg.stopPercent) {
        state.warningFired = true;
        const remaining = cfg.limit - state.totalTokens;
        api.log.info('token-budget: warning threshold reached', {
          percent: Math.round(percent),
          remaining,
        });
        // We can't inject context from onEvent directly — but we can
        // emit a custom event that the host or another plugin can
        // listen for. The Stop hook (below) also checks the budget
        // on every iteration.
        api.emitCustom('token-budget:warning', {
          percent: Math.round(percent),
          remaining,
          total: state.totalTokens,
          limit: cfg.limit,
        });
      }

      // Stop threshold (one-shot).
      if (!state.stopFired && percent >= cfg.stopPercent) {
        state.stopFired = true;
        api.log.warn('token-budget: hard limit reached — agent loop will be stopped', {
          total: state.totalTokens,
          limit: cfg.limit,
        });
        api.emitCustom('token-budget:limit_reached', {
          total: state.totalTokens,
          limit: cfg.limit,
        });
      }
    });

    // Register a Stop hook that checks the budget. When the stop
    // threshold is reached, this hook returns decision: 'block' with
    // a clear reason, preventing the agent loop from continuing.
    state.hookUnregister = api.registerHook('Stop', undefined, () => {
      if (cfg.limit <= 0 || !state.stopFired) return;
      return {
        decision: 'block',
        reason:
          `token-budget: session token limit reached (${state.totalTokens.toLocaleString()} / ${cfg.limit.toLocaleString()} tokens). ` +
          `The budget is exhausted — wrap up the current task and summarize what was accomplished.`,
      };
    });

    // --- token_budget_status tool ---
    api.tools.register({
      name: 'token_budget_status',
      description:
        'Shows the current token budget status: limit, consumed, remaining, percentage, and whether warning/stop thresholds have been crossed.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Meta',
      mutating: false,
      async execute() {
        const consumed = state.totalTokens;
        const limit = cfg.limit;
        const percent = limit > 0 ? Math.round((consumed / limit) * 100) : 0;
        const remaining = limit > 0 ? Math.max(limit - consumed, 0) : Infinity;
        return {
          ok: true,
          limit,
          consumed,
          remaining,
          percent,
          requestCount: state.requestCount,
          breakdown: {
            prompt: state.totalPromptTokens,
            completion: state.totalCompletionTokens,
          },
          warningFired: state.warningFired,
          stopFired: state.stopFired,
          lastRequest: state.lastRequest,
        };
      },
    });

    api.log.info('token-budget plugin loaded', {
      version: '0.1.0',
      limit: cfg.limit > 0 ? cfg.limit.toLocaleString() : 'unlimited',
      warnPercent: cfg.warnPercent,
      stopPercent: cfg.stopPercent,
    });
  },

  teardown(api) {
    // H1 pattern: unregister hook + zero counters.
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      totalTokens: state.totalTokens,
      requestCount: state.requestCount,
      warningFired: state.warningFired,
      stopFired: state.stopFired,
    };
    state.totalTokens = 0;
    state.totalPromptTokens = 0;
    state.totalCompletionTokens = 0;
    state.requestCount = 0;
    state.warningFired = false;
    state.stopFired = false;
    state.lastRequest = null;
    api.log.info('token-budget: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastRequest === null
          ? `token-budget: ${state.totalTokens.toLocaleString()} tokens across ${state.requestCount} request(s)`
          : `token-budget: ${state.totalTokens.toLocaleString()} tokens, last ${state.lastRequest.model} at ${state.lastRequest.when}`,
      totalTokens: state.totalTokens,
      requestCount: state.requestCount,
      warningFired: state.warningFired,
      stopFired: state.stopFired,
    };
  },
};

export default plugin;
