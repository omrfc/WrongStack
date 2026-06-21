/**
 * Model-runtime resolver + request-pipeline middleware.
 *
 * Maps the shared `Config.modelRuntime` settings into the per-request
 * `Request.reasoning` and `Request.cache` fields, gated by the active model's
 * `reasoningConfig` capabilities so unsupported values are omitted (and
 * surfaced as warnings) instead of triggering provider 400s.
 *
 * Wired once at boot (REPL/TUI/WebUI all go through the same `request`
 * pipeline) — see `installModelRuntimeMiddleware()`. UIs only need to mutate
 * `Config.modelRuntime` (and persist) for the change to take effect on the next
 * request.
 */
import type {
  ReasoningConfig,
  ReasoningRequest,
  Request,
  RequestCacheControl,
} from '../types/provider.js';
import type { ModelRuntimeConfig } from '../types/config.js';

export interface ResolvedModelRuntime {
  reasoning: Request['reasoning'];
  cache: Request['cache'];
  /** Human-readable warnings for settings that were ignored for this model. */
  warnings: string[];
}

/**
 * Resolve user-facing runtime settings into request fields for a specific
 * model capability profile. Pure function — safe to unit-test without a
 * provider or event bus.
 *
 * @param settings   `Config.modelRuntime` (may be undefined → no-op)
 * @param reasoning  The model's `reasoningConfig`, or undefined when unknown.
 *                   When undefined the resolver is conservative: explicit
 *                   on/off is suppressed (provider default wins) and effort is
 *                   dropped, because we cannot tell whether the model will
 *                   accept the fields.
 */
export function resolveModelRuntime(
  settings: ModelRuntimeConfig | undefined,
  reasoning: ReasoningConfig | undefined,
): ResolvedModelRuntime {
  const warnings: string[] = [];
  if (!settings) {
    return { reasoning: undefined, cache: undefined, warnings };
  }

  const reasoningField = resolveReasoningForRequest(settings, reasoning, warnings);
  const cacheField = resolveCacheForRequest(settings, warnings);

  return { reasoning: reasoningField, cache: cacheField, warnings };
}

export function resolveReasoningForRequest(
  settings: ModelRuntimeConfig,
  rc: ReasoningConfig | undefined,
  warnings: string[],
): Request['reasoning'] {
  const cfg = settings.reasoning;
  if (!cfg) return undefined;

  // Capability-unknown: be conservative. Sending explicit enabled/disabled to
  // a model that doesn't understand the field is a common source of 400s
  // (e.g. always-on Kimi code models reject `thinking: { type: "disabled" }`).
  const capKnown = rc !== undefined;
  const supportsReasoning = rc ? rc.default !== 'disabled' || rc.disableSupported || rc.effortSupported : false;

  const out: ReasoningRequest = {};

  if (cfg.mode === 'off') {
    if (capKnown && rc?.disableSupported) {
      out.enabled = false;
    } else if (capKnown && rc && rc.default === 'always_on') {
      warnings.push(
        'reasoning "off" requested, but this model has thinking always on; the disable field was omitted to avoid a provider error.',
      );
    } else if (capKnown && rc && !rc.disableSupported) {
      warnings.push('reasoning "off" requested, but this model does not support disabling thinking; the setting was omitted.');
    } else {
      // Unknown capabilities — don't risk sending an unsupported field.
      warnings.push('reasoning "off" requested, but model capabilities are unknown; the setting was omitted.');
    }
  } else if (cfg.mode === 'on') {
    if (!capKnown) {
      warnings.push('reasoning "on" requested, but model capabilities are unknown; the setting was omitted.');
    } else if (!supportsReasoning && rc?.default === 'disabled') {
      warnings.push('reasoning "on" requested, but this model has reasoning disabled by default and does not advertise support; the setting was omitted.');
    } else {
      out.enabled = true;
    }
  }
  // mode 'auto' → never send explicit enabled/disabled; provider default wins.

  const effort = cfg.effort;
  if (effort !== undefined) {
    if (capKnown && rc?.effortSupported && rc.effortLevels.includes(effort)) {
      out.effort = effort;
    } else if (capKnown && rc?.effortSupported) {
      warnings.push(
        `reasoning effort "${effort}" not supported by this model (supported: ${rc.effortLevels.join(', ')}); the setting was omitted.`,
      );
    } else if (capKnown) {
      warnings.push(`reasoning effort "${effort}" requested, but this model does not support effort; the setting was omitted.`);
    } else {
      warnings.push(`reasoning effort "${effort}" requested, but model capabilities are unknown; the setting was omitted.`);
    }
  }

  if (cfg.preserve !== undefined) {
    if (capKnown && rc && rc.preserveThinking !== 'unsupported') {
      out.preserve = cfg.preserve;
    } else if (capKnown) {
      warnings.push('reasoning preserve requested, but this model does not support preserved thinking; the setting was omitted.');
    }
    // Unknown capabilities: preserve is a soft, widely-supported field, so we
    // drop it rather than guess — provider behaviour varies too much.
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolveCacheForRequest(
  settings: ModelRuntimeConfig,
  _warnings: string[],
): Request['cache'] {
  const ttl = settings.cache?.ttl;
  if (ttl === undefined) return undefined;
  const out: RequestCacheControl = { ttl };
  return out;
}

export interface ModelRuntimeMiddlewareOptions {
  /** Provider id of the active model, for logging/diagnostics only. */
  providerId?: string | undefined;
  /** Model id of the active model, for logging/diagnostics only. */
  modelId?: string | undefined;
  /** Current runtime settings. Called per-request so live changes apply. */
  getSettings(): ModelRuntimeConfig | undefined;
  /** Current model capability profile. Called per-request. */
  getReasoningConfig(): ReasoningConfig | undefined;
  /** Optional sink for suppressed-setting warnings (e.g. emit to event bus). */
  onWarning?: ((message: string) => void) | undefined;
}

/**
 * Build a `request`-pipeline middleware that applies runtime settings. The
 * returned function mutates the outgoing request by overlaying resolved
 * `reasoning` / `cache` fields. Existing fields on the request are preserved
 * only when the resolver produces nothing for that field.
 */
export function applyModelRuntime(
  req: Request,
  opts: ModelRuntimeMiddlewareOptions,
): Request {
  const settings = opts.getSettings();
  if (!settings) return req;
  const rc = opts.getReasoningConfig();
  const resolved = resolveModelRuntime(settings, rc);
  for (const w of resolved.warnings) opts.onWarning?.(w);

  const next: Request = { ...req };
  if (resolved.reasoning !== undefined) {
    // Explicit runtime settings override anything the agent layer set, because
    // the user explicitly asked for this mode/effort for this session.
    next.reasoning = resolved.reasoning;
  }
  if (resolved.cache !== undefined) {
    next.cache = resolved.cache;
  }
  return next;
}
