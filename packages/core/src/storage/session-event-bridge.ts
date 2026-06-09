import type { SessionEvent, SessionWriter } from '../types/session.js';

export type AuditLevel = 'minimal' | 'standard' | 'full';

/**
 * Configuration for sampling high-volume events inside the bridge.
 * This allows callers (CLI, TUI, WebUI, plugins) to tune how aggressively
 * noisy events like tool progress are persisted.
 */
export interface ToolProgressSamplingOptions {
  /**
   * How often to persist 'log' and 'partial_output' progress events.
   * - 1 = every message (no sampling)
   * - 8 = keep the first message + every 8th after that (default)
   */
  sampleRate?: number | undefined;
}

export interface SessionSamplingOptions {
  /** Controls sampling behavior for `tool_progress` events (only relevant at auditLevel 'full'). */
  toolProgress?: ToolProgressSamplingOptions | undefined;
}

export interface SessionEventBridgeOptions {
  /** Sampling rules for high-volume audit events. */
  sampling?: SessionSamplingOptions | undefined;
}

/**
 * Small, safe helper that wraps a SessionWriter and enforces the
 * configured auditLevel.
 *
 * All appends are best-effort. Failures are swallowed (with optional
 * diagnostics) so they never crash the agent loop.
 */
export interface SessionEventBridge {
  /** Append an event if allowed by the current audit level. */
  append(event: SessionEvent): Promise<void>;
  /** Batch-append events allowed by the current audit level. */
  appendBatch(events: SessionEvent[]): Promise<void>;

  /** Current audit level this bridge was created with. */
  readonly level: AuditLevel;

  /** Returns true if an event of this type should be written at the current level. */
  allows(type: SessionEvent['type']): boolean;
}

/** Core events that are always written regardless of auditLevel. */
const CORE_RECONSTRUCT_EVENTS = new Set<SessionEvent['type']>([
  'session_start',
  'session_resumed',
  'user_input',
  'llm_response',
  'tool_result',
  'checkpoint',
  'file_snapshot',
  'rewound',
  'in_flight_start',
  'in_flight_end',
  'session_end',
]);

/**
 * Events that are considered "standard" audit detail.
 * These are lightweight and high-value for forensics.
 */
const STANDARD_AUDIT_EVENTS = new Set<SessionEvent['type']>([
  'llm_request',
  'tool_use',
  'tool_call_start',
  'tool_call_end',
  'compaction',
  'error',
  'message_truncated',
  'provider_retry',
  'provider_error',
]);

/**
 * Events that are only allowed at 'full' audit level because they can be
 * very high volume (e.g. streaming tool output).
 */
const FULL_ONLY_EVENTS = new Set<SessionEvent['type']>([
  'tool_progress',
]);

/**
 * "full" level allows everything (including potentially heavy events
 * that plugins or future code may emit).
 */
function isAllowed(type: SessionEvent['type'], level: AuditLevel): boolean {
  if (CORE_RECONSTRUCT_EVENTS.has(type)) return true;
  if (level === 'minimal') return false;

  if (STANDARD_AUDIT_EVENTS.has(type)) return true;
  if (level === 'standard') return false;

  // 'full' level events (high volume)
  if (FULL_ONLY_EVENTS.has(type)) {
    return level === 'full';
  }

  // 'full' — allow everything else
  return true;
}

/**
 * Create a safe, audit-level-aware bridge around a SessionWriter.
 *
 * The bridge can also apply sampling for high-volume events (e.g. `tool_progress`)
 * when `auditLevel` is set to `'full'`.
 *
 * @example
 * const bridge = createSessionEventBridge(sessionWriter, 'full', {
 *   sampling: {
 *     toolProgress: { sampleRate: 5 } // more aggressive sampling
 *   }
 * });
 */
export function createSessionEventBridge(
  writer: SessionWriter | undefined | null,
  level: AuditLevel = 'standard',
  options: SessionEventBridgeOptions = {},
): SessionEventBridge {
  const normalizedLevel: AuditLevel = level ?? 'standard';

  // Internal sampling state for high-volume events (e.g. tool_progress).
  // Keyed by tool call id (or name as fallback) to keep sampling per-call.
  const progressCounters = new Map<string, number>();

  const toolProgressConfig = options.sampling?.toolProgress ?? {};
  const TOOL_PROGRESS_SAMPLE_RATE = toolProgressConfig.sampleRate ?? 8;

  /**
   * Decide whether a high-volume event should be sampled in.
   * Currently only implements sampling for 'tool_progress'.
   */
  function shouldSample(event: SessionEvent): boolean {
    if (event.type !== 'tool_progress') return true;

    const progEvent = event as Extract<SessionEvent, { type: 'tool_progress' }>;
    const innerType = progEvent.event?.type;

    // Always let through high-signal structured events
    if (innerType === 'warning' || innerType === 'metric' || innerType === 'file_changed') {
      return true;
    }

    // Sample noisy text streams (log / partial_output)
    if (innerType === 'log' || innerType === 'partial_output') {
      const key = progEvent.id || progEvent.name;
      const count = (progressCounters.get(key) || 0) + 1;
      progressCounters.set(key, count);

      // Always keep the first message + every Nth after that
      return count === 1 || (count % TOOL_PROGRESS_SAMPLE_RATE === 0);
    }

    return true;
  }

  return {
    level: normalizedLevel,

    allows(type) {
      return isAllowed(type, normalizedLevel);
    },

    async append(event) {
      if (!writer) return;
      if (!isAllowed(event.type, normalizedLevel)) return;

      // Apply sampling for high-volume events (only at 'full' level)
      if (!shouldSample(event)) return;

      try {
        await writer.append(event);
      } catch (err) {
        // Best-effort: never let session logging break the agent.
        // The existing FileSessionWriter already does throttled warnings,
        // but we keep this wrapper silent by default to avoid log spam.
        // Callers that care can listen to EventBus 'session.damaged' etc.
      }
    },

    async appendBatch(events) {
      if (!writer || events.length === 0) return;
      const allowed = events.filter(
        (e) => isAllowed(e.type, normalizedLevel) && shouldSample(e),
      );
      if (allowed.length === 0) return;
      try {
        await writer.appendBatch(allowed);
      } catch {
        // best-effort — same contract as append()
      }
    },
  };
}

/** Convenience re-export of the allowed core set for tests/docs. */
export { CORE_RECONSTRUCT_EVENTS, STANDARD_AUDIT_EVENTS };

/**
 * Safely extract the auditLevel from a (possibly partial) Config object.
 * Falls back to 'standard' if not present or invalid.
 */
export function resolveAuditLevel(
  cfg?: { session?: { auditLevel?: AuditLevel | undefined } | undefined } | null,
): AuditLevel {
  const raw = cfg?.session?.auditLevel;
  if (raw === 'minimal' || raw === 'standard' || raw === 'full') {
    return raw;
  }
  return 'standard';
}

/**
 * Fully resolves the session logging configuration with sensible defaults.
 * This is the recommended way for the CLI / TUI / WebUI to read session config.
 */
export function resolveSessionLoggingConfig(
  cfg?: {
    session?: {
      auditLevel?: AuditLevel | undefined;
      sampling?: {
        toolProgress?: { sampleRate?: number | undefined };
      };
    };
  } | null,
): {
  auditLevel: AuditLevel;
  sampling: {
    toolProgress: { sampleRate: number };
  };
} {
  const session = cfg?.session ?? {};

  const auditLevel = resolveAuditLevel(cfg);

  const toolProgressSampleRate =
    session.sampling?.toolProgress?.sampleRate ?? 8;

  return {
    auditLevel,
    sampling: {
      toolProgress: {
        sampleRate: Math.max(1, Math.floor(toolProgressSampleRate)),
      },
    },
  };
}