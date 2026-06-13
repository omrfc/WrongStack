import {
  type AgentExtension,
  type Config,
  type EventBus,
  type Logger,
  type Provider,
  type ProviderConfig,
  ProviderError,
  StreamHangError,
} from '@wrongstack/core';

export interface FallbackModelDeps {
  /** Returns the live config (re-read each turn so `/model` switches are honored). */
  getConfig: () => Config;
  /**
   * Builds a credential-resolved Provider for a provider id (alias-resolved),
   * WITHOUT persisting anything to config/configStore. Supplied by the CLI boot
   * path, which shares this with the `/model` switch logic. May be async — the
   * subagent host resolves a provider's real context window asynchronously.
   */
  buildProvider: (providerId: string) => Provider | Promise<Provider>;
  /**
   * Called after the active model changes (a fallback hop or the primary
   * restore) so the host can refresh the auto-compaction / context-window
   * denominator — important when a fallback crosses to a smaller-window model.
   */
  onModelSwitch?: (providerId: string, modelId: string) => void;
  events: EventBus;
  /** Optional — warnings about un-buildable fallback providers. */
  logger?: Logger | undefined;
}

interface ModelRef {
  provider?: string | undefined;
  model: string;
}

/** Parse a fallback entry: `model`, `provider/model`, or `provider model`. */
export function parseModelRef(ref: string): ModelRef {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf('/');
  if (slash !== -1) {
    // An empty provider (leading slash, e.g. "/gpt") means "use the primary
    // provider" — collapse to undefined so the `?? cfg.provider` fallback fires.
    return {
      provider: trimmed.slice(0, slash) || undefined,
      model: trimmed.slice(slash + 1).trim(),
    };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return { provider: parts[0], model: parts.slice(1).join(' ') };
  }
  return { model: trimmed };
}

/**
 * Check if an error should trigger a fallback. Returns the status for
 * logging, or null if the error doesn't warrant a fallback attempt.
 *
 * Triggers on:
 *   - StreamHangError (always — the upstream endpoint stalled mid-response)
 *   - HTTP 429 (rate limited)
 *   - HTTP 529 (overloaded)
 *   - HTTP 5xx (server error)
 *   - HTTP 0 / network error (connection failure, DNS failure, etc.)
 */
function shouldFallback(err: unknown): number | null {
  if (err instanceof StreamHangError) {
    // Stream hangs are always worth falling back — the endpoint is
    // likely overloaded or has a routing issue.
    return 599;
  }
  if (!(err instanceof ProviderError)) return null;
  const s = err.status;
  // Network errors (status 0) — connection couldn't be established
  if (s === 0) return s;
  // Rate limits, overload, and server errors
  if (s === 429 || s === 529 || s >= 500) return s;
  return null;
}

/** A provider is usable as a fallback target when it has a stored key, a key
 *  list, or a populated env var. Mirrors `setmodel.providerHasKey`. */
function providerHasKey(entry: ProviderConfig | undefined): boolean {
  if (!entry) return false;
  if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) return true;
  if (Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => k?.apiKey)) return true;
  if (Array.isArray(entry.envVars) && entry.envVars.some((v) => !!process.env[v])) return true;
  return false;
}

/** Hard ceiling on the auto-derived chain so we don't burn through a dozen
 *  models on a transient blip. */
const SMART_DEFAULT_MAX = 4;

/**
 * Derive a fallback chain from the configured providers when the user has not
 * set an explicit `fallbackModels` list. Picks declared models from every
 * keyed provider — same-provider alternatives first (same key, cheapest
 * failover), then cross-provider — excluding the active leader model. Returns
 * `[]` when nothing usable is configured (e.g. providers with no `models`
 * list), in which case the extension is a no-op.
 */
export function smartDefaultFallbackChain(config: Config): string[] {
  const leaderProvider = config.provider;
  const leaderModel = config.model;
  const providers = config.providers ?? {};
  const seen = new Set<string>();
  const sameProvider: string[] = [];
  const crossProvider: string[] = [];

  // Leader provider first so its other models lead the chain.
  const ids = Object.keys(providers).sort((a, b) =>
    a === leaderProvider ? -1 : b === leaderProvider ? 1 : a.localeCompare(b),
  );

  for (const id of ids) {
    const entry = providers[id];
    if (!providerHasKey(entry)) continue;
    const models = entry?.models ?? [];
    for (const model of models) {
      if (id === leaderProvider && model === leaderModel) continue;
      const ref = `${id}/${model}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      (id === leaderProvider ? sameProvider : crossProvider).push(ref);
    }
  }
  return [...sameProvider, ...crossProvider].slice(0, SMART_DEFAULT_MAX);
}

/**
 * The effective fallback chain for a turn: the explicit `fallbackModels` list
 * when non-empty, otherwise the smart default (unless `fallbackAuto` is off).
 */
export function effectiveFallbackChain(config: Config): string[] {
  const explicit = config.fallbackModels ?? [];
  if (explicit.length > 0) return explicit;
  if (config.fallbackAuto === false) return [];
  return smartDefaultFallbackChain(config);
}

/**
 * Build the cross-provider fallback extension. Always returns an extension —
 * the effective chain (`effectiveFallbackChain`) is recomputed every turn from
 * the live config, so a chain that is empty at boot but populated later (via
 * `/fallback add` or the smart default kicking in once a key is added) takes
 * effect WITHOUT a restart. An empty chain makes the wrapper a no-op (it just
 * rethrows the original error).
 *
 * Mechanism (see plan): wraps the provider runner. The inner runner already
 * applies the per-model retry policy (backoff, up to 5 tries for 429), so the
 * fallback only engages AFTER the active model's own retries are exhausted.
 * Because the wrapper resolves within a single provider call, it does not
 * consume the agent loop's `recoveryRetries` budget — chains longer than two
 * entries work. `beforeRun` restores the configured primary at the start of
 * every turn, giving Claude's "retry the primary each user turn" semantics.
 */
export function createFallbackModelExtension(deps: FallbackModelDeps): AgentExtension {
  // True when a prior turn left the live context on a fallback model.
  let dirty = false;

  return {
    name: 'fallback-model',

    beforeRun: async (ctx) => {
      if (!dirty) return;
      const cfg = deps.getConfig();
      try {
        ctx.provider = await deps.buildProvider(cfg.provider);
        ctx.model = cfg.model;
        deps.onModelSwitch?.(cfg.provider, cfg.model);
      } catch (err) {
        deps.logger?.warn(
          `fallback-model: could not restore primary "${cfg.provider}/${cfg.model}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      dirty = false;
    },

    wrapProviderRunner: async (ctx, request, inner) => {
      try {
        return await inner(ctx, request);
      } catch (firstErr) {
        let lastErr: unknown = firstErr;
        const cfg = deps.getConfig();
        const chain = effectiveFallbackChain(cfg);

        for (const ref of chain) {
          const status = shouldFallback(lastErr);
          if (status === null) break; // not a fallback-worthy error

          const parsed = parseModelRef(ref);
          if (!parsed.model) continue;
          const targetProviderId = parsed.provider ?? cfg.provider;

          const from = { providerId: ctx.provider.id, model: ctx.model };

          let nextProvider: Provider;
          try {
            nextProvider = await deps.buildProvider(targetProviderId);
          } catch (err) {
            deps.logger?.warn(
              `fallback-model: skipping "${ref}" — cannot build provider "${targetProviderId}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            continue;
          }

          const providerSwitched = nextProvider.id !== from.providerId;
          ctx.provider = nextProvider;
          ctx.model = parsed.model;
          request.model = parsed.model;
          dirty = true;
          deps.onModelSwitch?.(targetProviderId, parsed.model);

          deps.events.emit('provider.fallback', {
            from,
            to: { providerId: nextProvider.id, model: parsed.model },
            status,
            providerSwitched,
          });

          try {
            return await inner(ctx, request);
          } catch (err) {
            lastErr = err;
          }
        }

        throw lastErr;
      }
    },
  };
}
