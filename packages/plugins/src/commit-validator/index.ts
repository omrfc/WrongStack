/**
 * commit-message-validator plugin — PreToolUse hook that validates
 * conventional-commit format on `git_autocommit` and `bash` (git commit)
 * before the commit is created.
 *
 * Tools registered:
 * - commit_validator_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PreToolUse with matcher `bash|git_autocommit`. Inspects the
 *   commit message (from toolInput.message for git_autocommit, or
 *   parsed from `-m` flag for bash git commit). If the message does
 *   not match the conventional-commit format, the call is blocked.
 *
 * Config (`config.extensions['commit-validator']`):
 *
 * ```jsonc
 * {
 *   "mode": "block",        // "block" | "warn"
 *   "requireScope": false,  // require a scope in parentheses
 *   "allowedTypes": [],     // empty = all types allowed; or ["feat","fix","docs",...]
 *   "maxSubjectLength": 72  // subject line character limit
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
  invocationCount: 0,
  validCount: 0,
  invalidCount: 0,
  hookUnregister: null as null | (() => void),
  lastValidation: null as null | {
    tool: string;
    valid: boolean;
    type: string;
    scope: string;
    subject: string;
    errors: string[];
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface CommitValidatorConfig {
  mode: 'block' | 'warn';
  requireScope: boolean;
  allowedTypes: string[];
  maxSubjectLength: number;
}

const DEFAULTS: CommitValidatorConfig = {
  mode: 'block',
  requireScope: false,
  allowedTypes: [],
  maxSubjectLength: 72,
};

function readConfig(raw: unknown): CommitValidatorConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    mode: r['mode'] === 'warn' ? 'warn' : 'block',
    requireScope: r['requireScope'] === true,
    allowedTypes: Array.isArray(r['allowedTypes'])
      ? (r['allowedTypes'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    maxSubjectLength: typeof r['maxSubjectLength'] === 'number' && r['maxSubjectLength'] > 0
      ? r['maxSubjectLength']
      : DEFAULTS.maxSubjectLength,
  };
}

// ---------------------------------------------------------------------------
// Conventional commit parser
// ---------------------------------------------------------------------------

interface ParsedCommit {
  valid: boolean;
  type: string;
  scope: string;
  subject: string;
  /** True if the commit has a breaking-change marker (`!`). */
  breaking: boolean;
  errors: string[];
}

// Standard conventional-commit types.
const STANDARD_TYPES = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
];

/**
 * Parse and validate a conventional-commit message.
 *
 * Format: `<type>[optional scope][!]: <description>`
 * Examples:
 *   feat: add new feature
 *   fix(auth): correct login redirect
 *   feat!: breaking change to API
 *   docs(readme): update installation steps
 */
function parseCommitMessage(message: string, cfg: CommitValidatorConfig): ParsedCommit {
  const errors: string[] = [];
  const firstLine = message.trim().split('\n')[0] ?? '';

  if (!firstLine) {
    return { valid: false, type: '', scope: '', subject: '', breaking: false, errors: ['empty commit message'] };
  }

  // Regex: type(scope)!: subject  or  type: subject  or  type!: subject
  // Groups: 1=type, 2=scope (optional), 3=breaking marker, 4=subject
  const match = firstLine.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);

  if (!match) {
    errors.push(
      `Message does not match conventional-commit format: "<type>[(scope)][!]: <description>". ` +
      `Got: "${firstLine.slice(0, 60)}"`,
    );
    return { valid: false, type: '', scope: '', subject: firstLine, breaking: false, errors };
  }

  const [, typeRaw, scopeRaw, breakingRaw, subjectRaw] = match;
  const type = (typeRaw ?? '').toLowerCase();
  const scope = scopeRaw ?? '';
  const breaking = breakingRaw === '!';
  const subject = subjectRaw ?? '';

  // Validate type.
  if (!type) {
    errors.push('Missing commit type (e.g. feat, fix, docs).');
  } else if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) {
    errors.push(
      `Type "${type}" is not in allowedTypes: ${cfg.allowedTypes.join(', ')}. ` +
      `Standard types: ${STANDARD_TYPES.join(', ')}.`,
    );
  } else if (cfg.allowedTypes.length === 0 && !STANDARD_TYPES.includes(type)) {
    // Warn about non-standard types but don't block (allowedTypes is empty = allow all).
    // We still accept it — some projects use custom types like "wip", "deps".
  }

  // Validate scope.
  if (cfg.requireScope && !scope) {
    errors.push('A scope is required (e.g. feat(auth): ...).');
  }

  // Validate subject.
  if (!subject) {
    errors.push('Missing subject description after the colon.');
  }
  if (subject.length > cfg.maxSubjectLength) {
    errors.push(
      `Subject is ${subject.length} characters — exceeds maxSubjectLength of ${cfg.maxSubjectLength}. ` +
      `Move details to the body.`,
    );
  }
  // Subject should NOT end with a period.
  if (subject.endsWith('.')) {
    errors.push('Subject should not end with a period.');
  }

  return {
    valid: errors.length === 0,
    type,
    scope,
    subject,
    breaking,
    errors,
  };
}

/**
 * Extract the commit message from a bash `git commit -m "..."` command.
 * Returns the message string, or null if no commit message was found.
 */
function extractMessageFromBash(command: string): string | null {
  // Match `git commit -m "message"` or `git commit -m 'message'`
  // Handles multiple -m flags (git concatenates them with \n).
  const flags: string[] = [];
  const doubleQuoted = command.matchAll(/-m\s+"([^"]*)"/g);
  const singleQuoted = command.matchAll(/-m\s+'([^']*)'/g);
  for (const m of doubleQuoted) flags.push(m[1] ?? '');
  for (const m of singleQuoted) flags.push(m[1] ?? '');

  if (flags.length === 0) return null;
  return flags.join('\n');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'commit-validator',
  version: '0.1.0',
  description: 'PreToolUse hook that validates conventional-commit format before git_autocommit or bash git commit runs',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['block', 'warn'],
        default: 'block',
        description: '"block" refuses the commit; "warn" injects errors as context but lets it through.',
      },
      requireScope: {
        type: 'boolean',
        default: false,
        description: 'Require a scope in parentheses (e.g. feat(auth): ...).',
      },
      allowedTypes: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Restrict to these commit types. Empty = allow all standard types (feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert) plus any custom type.',
      },
      maxSubjectLength: {
        type: 'number',
        minimum: 10,
        default: 72,
        description: 'Maximum subject line length in characters.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.validCount = 0;
    state.invalidCount = 0;
    state.hookUnregister = null;
    state.lastValidation = null;

    const cfg = readConfig(api.config.extensions?.['commit-validator']);

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
    }): { decision?: 'block' | 'allow' | undefined; reason?: string; additionalContext?: string } | void => {
      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;

      let message: string | null = null;

      if (toolName === 'git_autocommit') {
        // The git-autocommit plugin generates the message internally —
        // we can't intercept it before the tool runs. But the `message`
        // field in toolInput is the user-provided override (if any),
        // and the `type` field hints at the conventional type.
        // If the user provided a message, validate it. If not, trust
        // the plugin's heuristic.
        message = inp['message'] as string | undefined ?? null;
        if (!message) {
          // No user message — validate the type field instead.
          const type = inp['type'] as string | undefined;
          if (type && cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) {
            state.invocationCount += 1;
            state.invalidCount += 1;
            state.lastValidation = {
              tool: toolName, valid: false, type, scope: '', subject: '',
              errors: [`Type "${type}" is not in allowedTypes: ${cfg.allowedTypes.join(', ')}`],
              when: new Date().toISOString(),
            };
            if (cfg.mode === 'block') {
              return {
                decision: 'block',
                reason: `commit-validator: type "${type}" is not allowed. Allowed: ${cfg.allowedTypes.join(', ')}.`,
              };
            }
            return {
              decision: 'allow',
              additionalContext: `\n⚠️ commit-validator: type "${type}" is not in allowedTypes.`,
            };
          }
          return; // No message to validate, type is ok — let it through.
        }
      } else if (toolName === 'bash') {
        const command = inp['command'] as string | undefined;
        if (typeof command !== 'string') return;
        // Only intercept git commit commands.
        if (!/\bgit\s+commit\b/.test(command)) return;
        message = extractMessageFromBash(command);
        if (!message) return; // No -m flag found — can't validate, let it through.
      } else {
        return; // Not a commit tool.
      }

      state.invocationCount += 1;

      const parsed = parseCommitMessage(message, cfg);
      state.lastValidation = {
        tool: toolName,
        valid: parsed.valid,
        type: parsed.type,
        scope: parsed.scope,
        subject: parsed.subject,
        errors: parsed.errors,
        when: new Date().toISOString(),
      };

      if (parsed.valid) {
        state.validCount += 1;
        return; // Valid — let it through silently.
      }

      // Invalid commit message.
      state.invalidCount += 1;
      const errorList = parsed.errors.map((e) => `  • ${e}`).join('\n');
      const example = `feat: add user authentication\n  fix(api): correct response parsing\n  docs: update README`;

      if (cfg.mode === 'block') {
        return {
          decision: 'block',
          reason:
            `commit-validator: invalid conventional-commit message.\n` +
            `Errors:\n${errorList}\n\n` +
            `Expected format: <type>[(scope)][!]: <description>\n` +
            `Examples:\n  ${example}`,
        };
      }

      // mode === 'warn'
      return {
        decision: 'allow',
        additionalContext:
          `\n⚠️ commit-validator: commit message has ${parsed.errors.length} issue(s):\n${errorList}\n` +
          `Expected: <type>[(scope)][!]: <description>`,
      };
    };

    state.hookUnregister = api.registerHook('PreToolUse', 'bash|git_autocommit', hook);

    // --- commit_validator_status tool ---
    api.tools.register({
      name: 'commit_validator_status',
      description:
        'Reports commit-validator state: mode, allowedTypes, maxSubjectLength, and per-session valid/invalid counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Git',
      mutating: false,
      async execute() {
        return {
          ok: true,
          mode: cfg.mode,
          requireScope: cfg.requireScope,
          allowedTypes: cfg.allowedTypes,
          maxSubjectLength: cfg.maxSubjectLength,
          standardTypes: STANDARD_TYPES,
          counters: {
            invocations: state.invocationCount,
            valid: state.validCount,
            invalid: state.invalidCount,
          },
          lastValidation: state.lastValidation,
        };
      },
    });

    api.log.info('commit-validator plugin loaded', {
      version: '0.1.0',
      mode: cfg.mode,
      requireScope: cfg.requireScope,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      valid: state.validCount,
      invalid: state.invalidCount,
    };
    state.invocationCount = 0;
    state.validCount = 0;
    state.invalidCount = 0;
    state.lastValidation = null;
    api.log.info('commit-validator: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastValidation === null
          ? `commit-validator: ${state.invocationCount} validation(s), ${state.validCount} valid, ${state.invalidCount} invalid`
          : state.lastValidation.valid
            ? `commit-validator: last commit "${state.lastValidation.type}: ${state.lastValidation.subject.slice(0, 40)}" was valid`
            : `commit-validator: last commit was invalid (${state.lastValidation.errors.length} error(s)) at ${state.lastValidation.when}`,
      counters: {
        invocations: state.invocationCount,
        valid: state.validCount,
        invalid: state.invalidCount,
      },
      lastValidation: state.lastValidation,
    };
  },
};

export default plugin;
