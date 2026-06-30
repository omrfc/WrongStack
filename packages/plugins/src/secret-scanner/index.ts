/**
 * secret-scanner plugin — Pre-tool and post-tool hooks that block, redact,
 * or warn about plaintext credentials flowing into or out of tools.
 *
 * Tools registered:
 * - secret_scanner_status  : Show which patterns are active, recent
 *                            blocks/leaks, and current mode.
 * - secret_scanner_test    : Run the scanner against a user-supplied
 *                            string and report which patterns matched.
 *
 * Hooks registered:
 * - PreToolUse with matcher `bash|write|edit` (configurable). Default
 *   action is to BLOCK; the plugin can also auto-redact the offending
 *   fields via `HookOutcome.modifiedInput`.
 * - PostToolUse with matcher `*` (configurable via `postToolUseMatcher`).
 *   Scans tool OUTPUT for secrets that leaked through. Since the tool
 *   has already run, the hook cannot block — instead it injects an
 *   `additionalContext` warning so the LLM knows the output contains
 *   a secret and should NOT echo it, store it, or commit it.
 *
 * Why a separate plugin from the built-in `DefaultSecretScrubber`?
 * The scrubber is *output* sanitization (replace secrets with
 * `[REDACTED:type]` before they leave the system). The scanner is
 * *prevention* (stop the tool from running with a secret in the first
 *   place) + *detection* (flag secrets that leaked through the output).
 * They share the same threat model but act at different points in the
 * pipeline.
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

// Base patterns — always present, never removed by custom config.
// Custom patterns from config are APPENDED at setup() time.
const BASE_PATTERNS: Pattern[] = [
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
 * Active pattern set. Starts as a clone of BASE_PATTERNS; setup()
 * appends user-supplied custom patterns from config and rebuilds
 * COMBINED_REGEX. Teardown resets back to BASE_PATTERNS only.
 *
 * @internal
 */
let PATTERNS: Pattern[] = [...BASE_PATTERNS];

/**
 * Combined single-pass regex. Each alternative is a capturing group so
 * the matcher callback can identify which pattern fired (only one group
 * is non-undefined at match time). Rebuilt whenever PATTERNS changes.
 *
 * @internal
 */
let COMBINED_REGEX = buildCombinedRegex(PATTERNS);

/**
 * Rebuild the combined regex from a pattern array. Each pattern's
 * source is wrapped in a capturing group so findMatches/redactInput
 * can identify which one fired.
 *
 * @internal
 */
function buildCombinedRegex(patterns: Pattern[]): RegExp {
  return new RegExp(
    patterns.map((p) => `(${p.regex.source})`).join('|'),
    'g',
  );
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 pattern: shared between setup, teardown, health)
// ---------------------------------------------------------------------------

const state = {
  blockCount: 0,
  redactCount: 0,
  allowCount: 0,
  /** PostToolUse: secrets detected in tool output. */
  leakCount: 0,
  /** Most recent PreToolUse block — surfaced by `secret_scanner_status`. */
  lastBlock: null as null | {
    toolName: string;
    matchedTypes: string[];
    when: string;
  },
  /** Most recent PostToolUse leak — surfaced by `secret_scanner_status`. */
  lastLeak: null as null | {
    toolName: string;
    matchedTypes: string[];
    when: string;
  },
  /** PreToolUse hook handle so teardown can unregister. */
  hookUnregister: null as null | (() => void),
  /** PostToolUse hook handle so teardown can unregister. */
  postHookUnregister: null as null | (() => void),
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

interface CustomPattern {
  /** Unique identifier for this pattern (used in block reason + redaction label). */
  type: string;
  /** Regex source string (without `/…/g` delimiters). Must be a valid JS regex. */
  regex: string;
  /** Optional human-readable description. */
  description?: string | undefined;
}

interface SecretScannerConfig {
  /** PreToolUse: Tool-name matcher — pipe-delimited case-insensitive list, or '*'. */
  matcher: string;
  /** PostToolUse: Tool-name matcher for output scanning. Default '*' (all tools). */
  postToolUseMatcher: string;
  /** Action when a match is found in tool INPUT (PreToolUse). */
  mode: Mode;
  /** Set to false to short-circuit both hooks entirely (no scanning). */
  enabled: boolean;
  /** User-supplied custom patterns — appended to the 20 built-in patterns at setup() time. */
  customPatterns: CustomPattern[];
}

const DEFAULTS: SecretScannerConfig = {
  matcher: 'bash|write|edit',
  postToolUseMatcher: '*',
  mode: 'block',
  enabled: true,
  customPatterns: [],
};

function readConfig(raw: unknown): SecretScannerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const mode: Mode = r['mode'] === 'redact' || r['mode'] === 'allow' ? r['mode'] : 'block';
  const customPatterns: CustomPattern[] = [];
  if (Array.isArray(r['customPatterns'])) {
    for (const entry of r['customPatterns']) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const type = e['type'];
      const regex = e['regex'];
      if (typeof type !== 'string' || typeof regex !== 'string') continue;
      // Validate the regex compiles — skip entries that throw.
      try {
        new RegExp(regex, 'g');
      } catch {
        continue;
      }
      customPatterns.push({ type, regex, description: typeof e['description'] === 'string' ? e['description'] : undefined });
    }
  }
  return {
    matcher: typeof r['matcher'] === 'string' ? r['matcher'] : DEFAULTS.matcher,
    postToolUseMatcher: typeof r['postToolUseMatcher'] === 'string' ? r['postToolUseMatcher'] : DEFAULTS.postToolUseMatcher,
    mode,
    enabled: r['enabled'] === false ? false : true,
    customPatterns,
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
// PostToolUse hook — scan tool OUTPUT for leaked secrets
// ---------------------------------------------------------------------------

/**
 * Build a PostToolUse hook that scans the tool's output for secrets.
 *
 * Unlike PreToolUse, the tool has ALREADY run — we cannot block or
 * redact. Instead we inject `additionalContext` so the LLM knows:
 * "the tool output contains a plaintext secret — do NOT echo it,
 * store it, commit it, or send it to a third party."
 *
 * The counter is always bumped regardless of mode — detecting a leak
 * in `allow` mode is still operationally important.
 */
function buildPostHook(cfg: SecretScannerConfig, log: { warn: (msg: string, ...rest: unknown[]) => void }) {
  return (input: {
    toolName?: string | undefined;
    toolResult?: { content: string; isError: boolean } | undefined;
  }): { additionalContext?: string | undefined } | void => {
    if (!cfg.enabled) return;
    const result = input.toolResult;
    if (!result || typeof result.content !== 'string') return;

    const matched = findMatches(result.content);
    if (matched.length === 0) return;

    // A secret leaked through the tool output. We can't un-run the
    // tool, but we CAN tell the LLM to treat this output as sensitive.
    const toolName = input.toolName ?? 'unknown';
    const summary = matched.join(', ');
    const when = new Date().toISOString();

    state.leakCount += 1;
    state.lastLeak = { toolName, matchedTypes: matched, when };

    log.warn(
      `[secret-scanner] POST-TOOL LEAK: ${toolName} output matched ${summary}`,
    );

    return {
      additionalContext:
        `\n⚠️ secret-scanner: the output of '${toolName}' contains what appears to be ` +
        `plaintext credential(s) (${summary}). Do NOT echo, store, commit, or transmit ` +
        `this value. Treat it as compromised and advise the user to rotate it.`,
    };
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
        description: 'PreToolUse: Tool-name matcher (pipe-delimited case-insensitive, or "*")',
      },
      postToolUseMatcher: {
        type: 'string',
        default: '*',
        description: 'PostToolUse: Tool-name matcher for output leak detection. Default "*" scans all tool outputs.',
      },
      mode: {
        type: 'string',
        enum: ['block', 'redact', 'allow'],
        description:
          'PreToolUse action on a match: "block" refuses the tool call, "redact" rewrites the input with [REDACTED:type], "allow" only logs',
      },
      enabled: { type: 'boolean', default: true },
      customPatterns: {
        type: 'array',
        description: 'User-supplied custom credential patterns. Each entry is { type: string, regex: string, description?: string }. Appended to the 20 built-in patterns at setup() time.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Unique identifier (used in block reason + [REDACTED:type] label)' },
            regex: { type: 'string', description: 'Regex source string (without /…/g delimiters). Must be a valid JS regex.' },
            description: { type: 'string', description: 'Optional human-readable description' },
          },
          required: ['type', 'regex'],
        },
        default: [],
      },
    },
  },

  setup(api) {
    // Idempotent re-init: zero counters on reload (H1 pattern).
    state.blockCount = 0;
    state.redactCount = 0;
    state.allowCount = 0;
    state.leakCount = 0;
    state.lastBlock = null;
    state.lastLeak = null;
    state.hookUnregister = null;
    state.postHookUnregister = null;

    const cfg = readConfig(api.config.extensions?.['secret-scanner']);

    // Rebuild the active pattern set: start from BASE_PATTERNS, then
    // append user-supplied custom patterns. This is idempotent —
    // every setup() call resets to base first, so a reload never
    // accumulates duplicate custom entries.
    PATTERNS = [...BASE_PATTERNS];
    for (const cp of cfg.customPatterns) {
      try {
        PATTERNS.push({ type: cp.type, regex: new RegExp(cp.regex, 'g') });
      } catch {
        // readConfig already validated; this catch is defensive.
      }
    }
    COMBINED_REGEX = buildCombinedRegex(PATTERNS);

    const log = {
      warn: (msg: string, ...rest: unknown[]) => api.log.warn(msg, ...rest),
      info: (msg: string, ...rest: unknown[]) => api.log.info(msg, ...rest),
    };

    // Register the PreToolUse hook. registerHook returns an unregister
    // function we keep for teardown.
    const hook = buildHook(cfg, log);
    state.hookUnregister = api.registerHook('PreToolUse', cfg.matcher, hook);

    // Register the PostToolUse hook for output leak detection.
    const postHook = buildPostHook(cfg, log);
    state.postHookUnregister = api.registerHook('PostToolUse', cfg.postToolUseMatcher, postHook);

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
          postToolUseMatcher: cfg.postToolUseMatcher,
          patternCount: PATTERNS.length,
          patternTypes: PATTERNS.map((p) => p.type),
          counters: {
            block: state.blockCount,
            redact: state.redactCount,
            allow: state.allowCount,
            leak: state.leakCount,
          },
          lastBlock: state.lastBlock,
          lastLeak: state.lastLeak,
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
    // H1 pattern: unregister both hooks + zero counters on unload.
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // unregister may throw if the hook registry was already torn down;
        // teardown is best-effort.
      }
      state.hookUnregister = null;
    }
    if (state.postHookUnregister) {
      try {
        state.postHookUnregister();
      } catch {
        // same defensive catch
      }
      state.postHookUnregister = null;
    }
    const finalCounters = {
      block: state.blockCount,
      redact: state.redactCount,
      allow: state.allowCount,
      leak: state.leakCount,
    };
    state.blockCount = 0;
    state.redactCount = 0;
    state.allowCount = 0;
    state.leakCount = 0;
    state.lastBlock = null;
    state.lastLeak = null;
    // Reset patterns to base-only (remove any custom patterns from
    // the previous setup cycle).
    PATTERNS = [...BASE_PATTERNS];
    COMBINED_REGEX = buildCombinedRegex(PATTERNS);
    api.log.info('secret-scanner: teardown complete', { counters: finalCounters });
  },

  async health() {
    // /diag plugins wants a yes/no plus context. The hook is "ok" as
    // long as the plugin is loaded; surface counters + last block/leak
    // so an operator can confirm the scanner is live.
    return {
      ok: true,
      message:
        state.lastLeak !== null
          ? `secret-scanner: last leak at ${state.lastLeak.when} on ${state.lastLeak.toolName} (${state.lastLeak.matchedTypes.join(', ')})`
          : state.lastBlock !== null
            ? `secret-scanner: last block at ${state.lastBlock.when} on ${state.lastBlock.toolName} (${state.lastBlock.matchedTypes.join(', ')})`
            : `secret-scanner: ${state.blockCount + state.redactCount + state.allowCount + state.leakCount} invocations, no blocks or leaks`,
      counters: {
        block: state.blockCount,
        redact: state.redactCount,
        allow: state.allowCount,
        leak: state.leakCount,
      },
      lastBlock: state.lastBlock,
      lastLeak: state.lastLeak,
    };
  },
};

export default plugin;
