/**
 * Cross-provider fallback model extension.
 *
 * Lives in core so EVERY agent surface can reuse it: the CLI leader, the CLI
 * director/host subagent factory, and the runtime light subagent factory (used
 * by standalone SDD runs). It wraps the provider runner and, when the active
 * model 429s / overloads / stream-hangs, rotates through a fallback chain. The
 * chain is recomputed from live config every turn, so changes take effect
 * without a restart; an empty chain makes the wrapper a no-op.
 *
 * Moved here from `@wrongstack/cli` (it only ever depended on core types) so the
 * runtime light factory can wire fallbacks for SDD worker subagents.
 */
import type { AgentExtension } from '../extension/extension-points.js';
import type { EventBus } from '../kernel/events.js';
import type { Config, ProviderConfig } from '../types/config.js';

function visibleProviderModels(config: Config, providerId: string, providerModels: string[]): string[] {
  const entry = config.providers?.[providerId];
  return entry?.models !== undefined ? [...entry.models] : providerModels;
}
import type { Logger } from '../types/logger.js';
import { type Provider, ProviderError, StreamHangError } from '../types/provider.js';

export interface FallbackModelDeps {
  /** Returns the live config (re-read each turn so `/model` switches are honored). */
  getConfig: () => Config;
  /**
   * Builds a credential-resolved Provider for a provider id (alias-resolved),
   * WITHOUT persisting anything to config/configStore. Supplied by the boot
   * path, which shares this with the `/model` switch logic. May be async — the
   * subagent host resolves a provider's real context window asynchronously.
   */
  buildProvider: (providerId: string, modelId?: string | undefined) => Provider | Promise<Provider>;
  /**
   * Called after the active model changes (a fallback hop or the primary
   * restore) so the host can refresh the auto-compaction / context-window
   * denominator — important when a fallback crosses to a smaller-window model.
   */
  onModelSwitch?: (providerId: string, modelId: string) => void | Promise<void>;
  events: EventBus;
  /** Optional — warnings about un-buildable fallback providers. */
  logger?: Logger | undefined;
  /**
   * Base cooldown after the configured primary fails with a fallback-worthy
   * error. While active, `beforeRun` leaves the context on the working fallback
   * instead of retrying the primary at the start of every turn. Default: 60s.
   * Set 0 to preserve the legacy "probe primary every turn" behavior.
   */
  primaryCooldownMs?: number | undefined;
  /**
   * Maximum exponential cooldown for repeated failed primary probes. Default:
   * 10 minutes. Ignored when `primaryCooldownMs` is 0.
   */
  primaryCooldownMaxMs?: number | undefined;
  /** Test hook for deterministic cooldown assertions. */
  now?: (() => number) | undefined;
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

export function formatModelRef(ref: ModelRef, defaultProvider?: string | undefined): string {
  const provider = ref.provider ?? defaultProvider;
  return provider ? `${provider}/${ref.model}` : ref.model;
}

export function normalizeModelRef(ref: string, defaultProvider?: string | undefined): string {
  const parsed = parseModelRef(ref);
  return formatModelRef(parsed, defaultProvider);
}

export function fallbackProfileChain(config: Config, profileName: string | undefined): string[] {
  if (!profileName) return [];
  const chain = config.fallbackProfiles?.[profileName];
  return Array.isArray(chain) ? chain.filter((ref) => parseModelRef(ref).model) : [];
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
  const favoriteSet = new Set(
    (config.favoriteModels ?? []).map((ref) => normalizeModelRef(ref, leaderProvider)),
  );
  const hasFavorites = favoriteSet.size > 0;
  const favoritesOnly = config.favoriteModelsOnly === true;
  const seen = new Set<string>();
  const favoriteRefs: string[] = [];
  const sameProvider: string[] = [];
  const crossProvider: string[] = [];

  // Leader provider first so its other models lead the chain.
  const ids = Object.keys(providers).sort((a, b) =>
    a === leaderProvider ? -1 : b === leaderProvider ? 1 : a.localeCompare(b),
  );

  for (const id of ids) {
    const entry = providers[id];
    if (!providerHasKey(entry)) continue;
    const models = visibleProviderModels(config, id, entry?.models ?? []);
    for (const model of models) {
      if (id === leaderProvider && model === leaderModel) continue;
      const ref = `${id}/${model}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (favoriteSet.has(ref)) {
        favoriteRefs.push(ref);
        continue;
      }
      if (favoritesOnly && hasFavorites) continue;
      (id === leaderProvider ? sameProvider : crossProvider).push(ref);
    }
  }
  return [...favoriteRefs, ...sameProvider, ...crossProvider].slice(0, SMART_DEFAULT_MAX);
}

/**
 * The effective fallback chain for a turn: the explicit `fallbackModels` list
 * when non-empty, otherwise the smart default (unless `fallbackAuto` is off).
 */
export function effectiveFallbackChain(config: Config): string[] {
  const explicit = config.fallbackModels ?? [];
  const filteredExplicit = explicit.filter((ref) => {
    const parsed = parseModelRef(ref);
    if (!parsed.model) return false;
    const providerId = parsed.provider ?? config.provider;
    const entry = config.providers?.[providerId];
    if (!entry?.models) return true;
    return entry.models.includes(parsed.model);
  });
  if (filteredExplicit.length > 0) return filteredExplicit;
  if (config.fallbackAuto === false) return [];
  return smartDefaultFallbackChain(config);
}

const DEFAULT_PRIMARY_COOLDOWN_MS = 60_000;
const DEFAULT_PRIMARY_COOLDOWN_MAX_MS = 10 * 60_000;

function sameTarget(
  a: { providerId: string; model: string } | undefined,
  b: { providerId: string; model: string },
): boolean {
  return !!a && a.providerId === b.providerId && a.model === b.model;
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
 * entries work. `beforeRun` keeps the last working fallback while the primary
 * is cooling down, then restores the configured primary for a half-open probe.
 */
export function createFallbackModelExtension(deps: FallbackModelDeps): AgentExtension {
  // True when a prior turn left the live context on a fallback model.
  let dirty = false;
  let primaryFailureStreak = 0;
  let blockedPrimary: { providerId: string; model: string } | undefined;
  let primaryBlockedUntil = 0;

  const now = () => deps.now?.() ?? Date.now();
  const primaryTarget = (cfg: Config) => ({ providerId: cfg.provider, model: cfg.model });
  const cooldownBase = () => Math.max(0, deps.primaryCooldownMs ?? DEFAULT_PRIMARY_COOLDOWN_MS);
  const cooldownMax = () => Math.max(cooldownBase(), deps.primaryCooldownMaxMs ?? DEFAULT_PRIMARY_COOLDOWN_MAX_MS);
  const primaryInCooldown = (cfg: Config) =>
    sameTarget(blockedPrimary, primaryTarget(cfg)) && now() < primaryBlockedUntil;

  const markPrimaryFailure = (cfg: Config) => {
    const primary = primaryTarget(cfg);
    primaryFailureStreak = sameTarget(blockedPrimary, primary) ? primaryFailureStreak + 1 : 1;
    blockedPrimary = primary;
    const base = cooldownBase();
    if (base <= 0) {
      primaryBlockedUntil = 0;
      return;
    }
    const multiplier = 2 ** Math.max(0, primaryFailureStreak - 1);
    primaryBlockedUntil = now() + Math.min(cooldownMax(), base * multiplier);
  };

  const resetPrimaryLadder = (cfg: Config) => {
    if (!sameTarget(blockedPrimary, primaryTarget(cfg))) return;
    primaryFailureStreak = 0;
    blockedPrimary = undefined;
    primaryBlockedUntil = 0;
  };

  return {
    name: 'fallback-model',

    beforeRun: async (ctx) => {
      if (!dirty) return;
      const cfg = deps.getConfig();
      if (primaryInCooldown(cfg)) return;
      try {
        ctx.provider = await deps.buildProvider(cfg.provider, cfg.model);
        ctx.model = cfg.model;
        await deps.onModelSwitch?.(cfg.provider, cfg.model);
        // The next provider call is the half-open primary probe. If it
        // succeeds, the wrapper resets the ladder; if it fails, the catch path
        // marks a longer cooldown and rotates back through the chain.
        primaryBlockedUntil = 0;
      } catch (err) {
        deps.logger?.warn(
          `fallback-model: could not restore primary "${cfg.provider}/${cfg.model}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        markPrimaryFailure(cfg);
        return;
      }
      dirty = false;
    },

    wrapProviderRunner: async (ctx, request, inner) => {
      try {
        const response = await inner(ctx, request);
        const cfg = deps.getConfig();
        if (ctx.provider.id === cfg.provider && ctx.model === cfg.model) {
          resetPrimaryLadder(cfg);
        }
        return response;
      } catch (firstErr) {
        let lastErr: unknown = firstErr;
        const cfg = deps.getConfig();
        const chain = effectiveFallbackChain(cfg);
        if (shouldFallback(firstErr) !== null && ctx.provider.id === cfg.provider && ctx.model === cfg.model) {
          markPrimaryFailure(cfg);
        }

        for (const ref of chain) {
          const status = shouldFallback(lastErr);
          if (status === null) break; // not a fallback-worthy error

          const parsed = parseModelRef(ref);
          if (!parsed.model) continue;
          const targetProviderId = parsed.provider ?? cfg.provider;
          if (targetProviderId === ctx.provider.id && parsed.model === ctx.model) continue;
          if (
            primaryInCooldown(cfg) &&
            targetProviderId === cfg.provider &&
            parsed.model === cfg.model
          ) {
            continue;
          }

          const from = { providerId: ctx.provider.id, model: ctx.model };

          let nextProvider: Provider;
          try {
            nextProvider = await deps.buildProvider(targetProviderId, parsed.model);
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
          await deps.onModelSwitch?.(targetProviderId, parsed.model);

          deps.events.emit('provider.fallback', {
            sessionId: ctx.session?.id,
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
