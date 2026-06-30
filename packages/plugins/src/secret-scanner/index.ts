/**
 * secret-scanner plugin — Pre-tool hook that blocks (or redacts) tools
 * whose arguments contain plaintext credentials.
 *
 * Tools registered:
 * - secret_scanner_status  : Show which patterns are active, recent
 *                            blocks, and current mode.
 * - secret_scanner_test    : Run the scanner against a user-supplied
 *                            string and report which patterns matched.
 *
 * Hooks registered:
 * - PreToolUse with matcher `bash|write|edit` (configurable). Default
 *   action is to BLOCK; the plugin can also auto-redact the offending
 *   fields via `HookOutcome.modifiedInput`.
 *
 * Why a separate plugin from the built-in `DefaultSecretScrubber`?
 * The scrubber is *output* sanitization (replace secrets with
 * `[REDACTED:type]` before they leave the system). The scanner is
 * *prevention* (stop the tool from running with a secret in the first
 * place). They share the same threat model but act at different points
 * in the pipeline.
 */
import type { Plugin } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Pattern set
// ---------------------------------------------------------------------------
//
// Mirrors the simple patterns in `core/src/security/secret-scrubber.ts`,
// minus the high-entropy-env detector (which is too slow + too
// false-positive prone for a synchronous pre-tool gate). Adding a new
// pattern here is cheap: each entry is a tuple of (id, regex). The
// combined regex folds every pattern into one pass, with the matched
// group's position used to index into the id list.

interface Pattern {
  type: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  // LLM provider keys
  { type: 'anthropic_key', regex: /(?<![A-Za-z0-9])sk-ant-api\d+-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g },
  { type: 'openai_key', regex: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g },
  // GitHub
  { type: 'github_pat', regex: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g },
  { type: 'github_pat_v2', regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9])/g },
  // AWS
  { type: 'aws_access_key', regex: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  // GCP
  { type: 'gcp_key', regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9])/g },
  // Slack
  { type: 'slack_token', regex: /(?<![A-Za-z0-9-])xox[abpos]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g },
  // Stripe
  { type: 'stripe_key', regex: /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g },
  // Twilio
  { type: 'twilio_sid', regex: /(?<![A-Za-z0-9])AC[a-f0-9]{32}(?![A-Za-z0-9])/g },
  // Telegram
  {
    type: 'telegram_bot_token',
    regex: /\/bot\d+:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  },
  // JWT
  {
    type: 'jwt',
    regex: /(?<![A-Za-z0-9/+=])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9/+=])/g,
  },
  // Private keys
  {
    type: 'private_key',
    regex: /(?:^|\n)-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP)? ?PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|OPENSSH|DSA|PGP)? ?PRIVATE KEY-----(?!\S)/g,
  },
  // AI/ML provider tokens
  { type: 'huggingface_token', regex: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9])/g },
  { type: 'replicate_token', regex: /(?<![A-Za-z0-9])r8_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g },
  { type: 'perplexity_key', regex: /(?<![A-Za-z0-9])pplx-[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g },
  { type: 'groq_key', regex: /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g },
  // Bearer tokens
  {
    type: 'bearer_token',
    regex: /(?:^|[^A-Za-z0-9_.~+/-])Bearer\s+[A-Za-z0-9._~+/-]{12,512}=*(?![A-Za-z0-9._~+/-])/g,
  },
  // Database URIs
  { type: 'mongodb_uri', regex: /mongodb(?:\+srv)?:\/\/[^\s"'`]+/g },
  { type: 'postgres_uri', regex: /postgres(?:ql)?:\/\/[^\s"'`]+/g },
  { type: 'mysql_uri', regex: /mysql:\/\/[^\s"'`]+/g },
  { type: 'redis_uri', regex: /redis:\/\/[^\s"'`]+/g },
];

/**
 * Combined single-pass regex. Each alternative is a capturing group so
 * the matcher callback can identify which pattern fired (only one group
 * is non-undefined at match time). The leading delimiter of `bearer_token`
 * is also captured but the replacement is grouped on the inner value —
 * see `redactMatches` for the consumer.
 */
const COMBINED_REGEX = new RegExp(
  PATTERNS.map((p) => `(${p.regex.source})`).join('|'),
  'g',
);

// ---------------------------------------------------------------------------
// Module-scope state (H1 pattern: shared between setup, teardown, health)
// ---------------------------------------------------------------------------

const state = {
  blockCount: 0,
  redactCount: 0,
  allowCount: 0,
  /** Most recent block — surfaced by `secret_scanner_status`. */
  lastBlock: null as null | {
    toolName: string;
    matchedTypes: string[];
    when: string;
  },
  /** Hook handle so teardown can unregister. */
  hookUnregister: null as null | (() => void),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find every pattern that fires on `text`. Returns the list of matched
 * `type` ids (deduped). The combined regex is one pass; the capture
 * group index maps back to the pattern via the parallel PATTERNS array.
 */
function findMatches(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  COMBINED_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMBINED_REGEX.exec(text)) !== null) {
    // Determine which capture group matched by scanning for the first
    // defined group beyond group 0. The combined regex has one
    // capturing group per pattern, in PATTERNS order.
    for (let i = 0; i < PATTERNS.length; i++) {
      if (m[i + 1] !== undefined) {
        found.add(PATTERNS[i]!.type);
        break;
      }
    }
    // Defensive: avoid infinite loop on zero-width matches (none of the
    // current patterns are zero-width, but future additions might be).
    if (m.index === COMBINED_REGEX.lastIndex) {
      COMBINED_REGEX.lastIndex += 1;
    }
  }
  return Array.from(found);
}

/**
 * Walk an arbitrary input value, return the first set of matched types
 * found in any string-typed leaf. Returns `null` if nothing matched
 * anywhere — saves the caller from scanning more fields once a hit is
 * confirmed.
 */
function scanInput(input: unknown): string[] | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') {
    const found = findMatches(input);
    return found.length > 0 ? found : null;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = scanInput(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof input === 'object') {
    for (const value of Object.values(input as Record<string, unknown>)) {
      const found = scanInput(value);
      if (found) return found;
    }
    return null;
  }
  // Numbers, booleans, bigints — credentials are strings, no point scanning.
  return null;
}

/**
 * Walk an arbitrary input value, returning a deep clone with every
 * string-typed leaf redacted. Only used in `mode: 'redact'`. The walk
 * mirrors `scanInput` so the two functions stay in sync.
 */
function redactInput(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    return input.replace(COMBINED_REGEX, (_match, ...groups: unknown[]) => {
      for (let i = 0; i < PATTERNS.length; i++) {
        if (groups[i] !== undefined) {
          return `[REDACTED:${PATTERNS[i]!.type}]`;
        }
      }
      return '[REDACTED:unknown]';
    });
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactInput(item));
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = redactInput(v);
    }
    return out;
  }
  return input;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Mode = 'block' | 'redact' | 'allow';

interface SecretScannerConfig {
  /** Tool-name matcher — pipe-delimited case-insensitive list, or '*'. */
  matcher: string;
  /** Action when a match is found. */
  mode: Mode;
  /** Set to false to short-circuit the hook entirely (no scanning). */
  enabled: boolean;
}

const DEFAULTS: SecretScannerConfig = {
  matcher: 'bash|write|edit',
  mode: 'block',
  enabled: true,
};

function readConfig(raw: unknown): SecretScannerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const mode: Mode = r['mode'] === 'redact' || r['mode'] === 'allow' ? r['mode'] : 'block';
  return {
    matcher: typeof r['matcher'] === 'string' ? r['matcher'] : DEFAULTS.matcher,
    mode,
    enabled: r['enabled'] === false ? false : true,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function buildHook(cfg: SecretScannerConfig, log: { warn: (msg: string, ...rest: unknown[]) => void; info: (msg: string, ...rest: unknown[]) => void }) {
  return (input: { toolName?: string | undefined; toolInput?: unknown }): { decision?: 'block' | 'allow' | undefined; reason?: string | undefined; modifiedInput?: Record<string, unknown>; additionalContext?: string | undefined } | void => {
    if (!cfg.enabled) return;
    const toolName = input.toolName ?? 'unknown';
    const matched = scanInput(input.toolInput);
    if (!matched) return;
    // We have at least one match. Branch on mode.
    const summary = matched.join(', ');
    const when = new Date().toISOString();
    if (cfg.mode === 'block') {
      state.blockCount += 1;
      state.lastBlock = { toolName, matchedTypes: matched, when };
      log.warn(
        `[secret-scanner] blocked ${toolName} — matched: ${summary}`,
      );
      return {
        decision: 'block',
        reason:
          `secret-scanner: refused to run '${toolName}' because the arguments ` +
          `appear to contain plaintext credentials (${summary}). ` +
          `Move the secret to a secret manager, env var, or config file and re-issue the call.`,
      };
    }
    if (cfg.mode === 'redact') {
      const redacted = redactInput(input.toolInput);
      if (
        redacted !== null &&
        typeof redacted === 'object' &&
        !Array.isArray(redacted)
      ) {
        state.redactCount += 1;
        log.info(
          `[secret-scanner] redacted ${toolName} — matched: ${summary}`,
        );
        return {
          decision: 'allow',
          modifiedInput: redacted as Record<string, unknown>,
          additionalContext:
            `secret-scanner: redacted ${matched.length} credential pattern(s) from the ${toolName} arguments before execution.`,
        };
      }
      // Fall through to block if redaction can't produce a valid input
      // shape (the input wasn't a plain object).
      state.blockCount += 1;
      state.lastBlock = { toolName, matchedTypes: matched, when };
      return {
        decision: 'block',
        reason:
          `secret-scanner: cannot safely redact '${toolName}' input (non-object shape); refusing to run.`,
      };
    }
    // mode === 'allow' — just count and log, never block.
    state.allowCount += 1;
    log.warn(
      `[secret-scanner] allow-mode: ${toolName} matched ${summary} but mode='allow' lets it through.`,
    );
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'secret-scanner',
  version: '0.1.0',
  description:
    'Pre-tool hook that blocks (or optionally redacts) tools whose arguments contain plaintext credentials',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      matcher: {
        type: 'string',
        description: 'Tool-name matcher passed to the hook registry (pipe-delimited case-insensitive, or "*")',
      },
      mode: {
        type: 'string',
        enum: ['block', 'redact', 'allow'],
        description:
          'Action on a match: "block" refuses the tool call, "redact" rewrites the input with [REDACTED:type], "allow" only logs',
      },
      enabled: { type: 'boolean', default: true },
    },
  },

  setup(api) {
    // Idempotent re-init: zero counters on reload (H1 pattern).
    state.blockCount = 0;
    state.redactCount = 0;
    state.allowCount = 0;
    state.lastBlock = null;

    const cfg = readConfig(api.config.extensions?.['secret-scanner']);
    const log = {
      warn: (msg: string, ...rest: unknown[]) => api.log.warn(msg, ...rest),
      info: (msg: string, ...rest: unknown[]) => api.log.info(msg, ...rest),
    };

    // Register the PreToolUse hook. registerHook returns an unregister
    // function we keep for teardown.
    const hook = buildHook(cfg, log);
    state.hookUnregister = api.registerHook('PreToolUse', cfg.matcher, hook);

    // --- secret_scanner_status tool ---
    api.tools.register({
      name: 'secret_scanner_status',
      description:
        'Reports the current secret-scanner state: pattern count, last block (if any), and per-mode invocation counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          matcher: cfg.matcher,
          patternCount: PATTERNS.length,
          patternTypes: PATTERNS.map((p) => p.type),
          counters: {
            block: state.blockCount,
            redact: state.redactCount,
            allow: state.allowCount,
          },
          lastBlock: state.lastBlock,
        };
      },
    });

    // --- secret_scanner_test tool ---
    api.tools.register({
      name: 'secret_scanner_test',
      description:
        'Run the scanner against a user-supplied string and report which patterns matched. Useful for verifying config and tuning the matcher.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to scan for credential patterns' },
        },
        required: ['text'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const text = typeof input['text'] === 'string' ? (input['text'] as string) : '';
        const matched = findMatches(text);
        return {
          ok: true,
          matched,
          count: matched.length,
        };
      },
    });

    api.log.info('secret-scanner plugin loaded', {
      version: '0.1.0',
      mode: cfg.mode,
      matcher: cfg.matcher,
      patterns: PATTERNS.length,
    });
  },

  teardown(api) {
    // H1 pattern: unregister the hook + zero counters on unload.
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // unregister may throw if the hook registry was already torn down;
        // teardown is best-effort.
      }
      state.hookUnregister = null;
    }
    const finalCounters = {
      block: state.blockCount,
      redact: state.redactCount,
      allow: state.allowCount,
    };
    state.blockCount = 0;
    state.redactCount = 0;
    state.allowCount = 0;
    state.lastBlock = null;
    api.log.info('secret-scanner: teardown complete', { counters: finalCounters });
  },

  async health() {
    // /diag plugins wants a yes/no plus context. The hook is "ok" as
    // long as the plugin is loaded; surface counters + last block so
    // an operator can confirm the scanner is live.
    return {
      ok: true,
      message:
        state.lastBlock === null
          ? `secret-scanner: ${state.blockCount + state.redactCount + state.allowCount} invocations, no blocks`
          : `secret-scanner: last block at ${state.lastBlock.when} on ${state.lastBlock.toolName} (${state.lastBlock.matchedTypes.join(', ')})`,
      counters: {
        block: state.blockCount,
        redact: state.redactCount,
        allow: state.allowCount,
      },
      lastBlock: state.lastBlock,
    };
  },
};

export default plugin;
