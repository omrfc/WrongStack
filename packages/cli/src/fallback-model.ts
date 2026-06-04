import {
  type AgentExtension,
  type Config,
  type EventBus,
  type Logger,
  type Provider,
  ProviderError,
} from '@wrongstack/core';

export interface FallbackModelDeps {
  /** Returns the live config (re-read each turn so `/model` switches are honored). */
  getConfig: () => Config;
  /**
   * Builds a credential-resolved Provider for a provider id (alias-resolved),
   * WITHOUT persisting anything to config/configStore. Supplied by the CLI boot
   * path, which shares this with the `/model` switch logic.
   */
  buildProvider: (providerId: string) => Provider;
  /**
   * Called after the active model changes (a fallback hop or the primary
   * restore) so the host can refresh the auto-compaction / context-window
   * denominator — important when a fallback crosses to a smaller-window model.
   */
  onModelSwitch?: (providerId: string, modelId: string) => void;
  events: EventBus;
  logger: Logger;
}

interface ModelRef {
  provider?: string;
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

function overloadStatus(err: unknown): number | null {
  if (!(err instanceof ProviderError)) return null;
  const s = err.status;
  if (s === 429 || s === 529 || s >= 500) return s;
  return null;
}

/**
 * Build the cross-provider fallback extension. Returns `null` when no
 * `fallbackModels` are configured, so the caller can skip registration.
 *
 * Mechanism (see plan): wraps the provider runner. The inner runner already
 * applies the per-model retry policy (backoff, up to 5 tries for 429), so the
 * fallback only engages AFTER the active model's own retries are exhausted.
 * Because the wrapper resolves within a single provider call, it does not
 * consume the agent loop's `recoveryRetries` budget — chains longer than two
 * entries work. `beforeRun` restores the configured primary at the start of
 * every turn, giving Claude's "retry the primary each user turn" semantics.
 */
export function createFallbackModelExtension(deps: FallbackModelDeps): AgentExtension | null {
  const initial = deps.getConfig().fallbackModels ?? [];
  if (initial.length === 0) return null;

  // True when a prior turn left the live context on a fallback model.
  let dirty = false;

  return {
    name: 'fallback-model',

    beforeRun: (ctx) => {
      if (!dirty) return;
      const cfg = deps.getConfig();
      try {
        ctx.provider = deps.buildProvider(cfg.provider);
        ctx.model = cfg.model;
        deps.onModelSwitch?.(cfg.provider, cfg.model);
      } catch (err) {
        deps.logger.warn(
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
        const chain = cfg.fallbackModels ?? [];

        for (const ref of chain) {
          const status = overloadStatus(lastErr);
          if (status === null) break; // not an overload — stop falling back

          const parsed = parseModelRef(ref);
          if (!parsed.model) continue;
          const targetProviderId = parsed.provider ?? cfg.provider;

          const from = { providerId: ctx.provider.id, model: ctx.model };

          let nextProvider: Provider;
          try {
            nextProvider = deps.buildProvider(targetProviderId);
          } catch (err) {
            deps.logger.warn(
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
