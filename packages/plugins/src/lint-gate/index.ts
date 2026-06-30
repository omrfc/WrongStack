/**
 * lint-gate plugin — PreToolUse hook that runs biome (or eslint) on
 * the would-be file content before `write` or `edit` commits it.
 *
 * Tools registered:
 * - lint_gate_status : Show config, linter, and per-session counters.
 *
 * Hooks registered:
 * - PreToolUse with matcher `write|edit`. For `write`, the full
 *   content is available in `toolInput.content` — it's written to a
 *   temp file and linted. For `edit`, the current file is read, the
 *   `old_string → new_string` replacement is applied in-memory, and
 *   the result is linted.
 *
 * Config (`config.extensions['lint-gate']`):
 *
 * ```jsonc
 * {
 *   "linter": "biome",       // "biome" | "eslint" | "auto"
 *   "mode": "warn",          // "block" (refuse the call) | "warn" (inject context)
 *   "severity": "error",     // minimum severity to act on: "error" | "warning"
 *   "timeoutMs": 10000       // linter process timeout
 * }
 * ```
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  /** Total PreToolUse invocations. */
  invocationCount: 0,
  /** Times the linter found issues at or above the severity threshold. */
  hitCount: 0,
  /** Times the linter auto-fixed content (fix mode only). */
  fixCount: 0,
  /** Times the linter process itself failed (timeout, not installed, etc.). */
  linterErrorCount: 0,
  /** Hook handle for teardown. */
  hookUnregister: null as null | (() => void),
  /** Last lint result summary — surfaced by health() + status tool. */
  lastResult: null as null | {
    tool: string;
    path: string;
    issueCount: number;
    severities: string[];
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Linter = 'biome' | 'eslint' | 'auto';
type Mode = 'block' | 'warn' | 'fix';
type Severity = 'error' | 'warning';

interface LintGateConfig {
  linter: Linter;
  mode: Mode;
  severity: Severity;
  timeoutMs: number;
  /**
   * When mode='fix', only auto-fix issues matching these rule IDs.
   * Empty = fix everything the linter can. Non-empty = fix only the
   * listed rules, leave others as warnings.
   */
  fixRules: string[];
}

const DEFAULTS: LintGateConfig = {
  linter: 'auto',
  mode: 'warn',
  severity: 'error',
  timeoutMs: 10_000,
  fixRules: [],
};

function readConfig(raw: unknown): LintGateConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    linter: r['linter'] === 'biome' || r['linter'] === 'eslint' ? r['linter'] : 'auto',
    mode: r['mode'] === 'block' ? 'block' : r['mode'] === 'fix' ? 'fix' : 'warn',
    severity: r['severity'] === 'warning' ? 'warning' : 'error',
    timeoutMs: typeof r['timeoutMs'] === 'number' ? r['timeoutMs'] : DEFAULTS.timeoutMs,
    fixRules: Array.isArray(r['fixRules'])
      ? (r['fixRules'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
  };
}

// ---------------------------------------------------------------------------
// Linter detection
// ---------------------------------------------------------------------------

/**
 * Detect which linter is available. "auto" tries biome first, then eslint.
 * Returns the linter command + args prefix, or null if neither is found.
 */
function detectLinter(requested: Linter): { cmd: string; args: string[]; name: string } | null {
  const tryBiome = requested === 'biome' || requested === 'auto';
  const tryEslint = requested === 'eslint' || requested === 'auto';

  if (tryBiome) {
    try {
      execSync('npx biome --version', { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { cmd: 'npx', args: ['biome', 'check', '--reporter=json'], name: 'biome' };
    } catch {
      // biome not available
    }
  }
  if (tryEslint) {
    try {
      execSync('npx eslint --version', { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { cmd: 'npx', args: ['eslint', '--format=json'], name: 'eslint' };
    } catch {
      // eslint not available
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Linter execution
// ---------------------------------------------------------------------------

interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  line?: number;
}

/**
 * Run the linter on a temp file and parse the output.
 * Returns the list of issues found, or null if the linter itself failed.
 */
function lintContent(
  content: string,
  filePath: string,
  linter: { cmd: string; args: string[]; name: string },
  timeoutMs: number,
): LintIssue[] | null {
  // Create a temp directory and write the content with the same extension
  // as the target file so the linter applies the right rules.
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '.ts';
  const tmpDir = mkdtempSync(join(tmpdir(), 'lint-gate-'));
  const tmpFile = join(tmpDir, `input${ext}`);
  try {
    writeFileSync(tmpFile, content, 'utf-8');
    const fullArgs = [...linter.args, tmpFile];
    let stdout = '';
    try {
      stdout = execSync(`${linter.cmd} ${fullArgs.map((a) => `"${a}"`).join(' ')}`, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; killed?: boolean };
      if (e.killed) return null; // timeout
      // Linters exit non-zero when they find issues — stdout has the JSON.
      if (e.stdout) stdout = e.stdout;
      else return null;
    }
    return parseLinterOutput(stdout, linter.name);
  } catch {
    return null;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Run the linter with auto-fix enabled, returning the fixed content.
 * Biome: `biome check --write`. ESLint: `eslint --fix`.
 *
 * The fix runs on the SAME temp file as `lintContent`. After the
 * linter exits, the file is read back and returned. If the linter
 * fails or the content is unchanged, the original content is returned
 * (so the caller falls through to warn mode gracefully).
 *
 * @internal
 */
function lintAndFix(
  content: string,
  filePath: string,
  linter: { cmd: string; args: string[]; name: string },
  timeoutMs: number,
): string {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '.ts';
  const tmpDir = mkdtempSync(join(tmpdir(), 'lint-gate-fix-'));
  const tmpFile = join(tmpDir, `input${ext}`);
  try {
    writeFileSync(tmpFile, content, 'utf-8');
    // Build the fix command: biome uses `check --write`, eslint uses `--fix`.
    const fixArgs =
      linter.name === 'biome'
        ? ['biome', 'check', '--write', tmpFile]
        : ['eslint', '--fix', tmpFile];
    try {
      execSync(`${linter.cmd} ${fixArgs.map((a) => `"${a}"`).join(' ')}`, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const e = err as { killed?: boolean };
      if (e.killed) return content; // timeout — return original
      // Linters exit non-zero even after fixing. The file may still
      // have been written to — read it back regardless.
    }
    return readFileSync(tmpFile, 'utf-8');
  } catch {
    return content; // any error → return original
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Parse linter JSON output into a flat list of issues.
 * Biome: `{ diagnostics: [{ category, severity, description, location }] }`
 * ESLint: `[{ messages: [{ ruleId, severity, message, line }] }]`
 */
function parseLinterOutput(stdout: string, linterName: string): LintIssue[] {
  const issues: LintIssue[] = [];
  try {
    const data = JSON.parse(stdout);
    if (linterName === 'biome') {
      for (const d of data.diagnostics ?? []) {
        const cat = d.category ?? 'unknown';
        const sev = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info';
        issues.push({
          severity: sev,
          rule: cat,
          message: d.description ?? cat,
          line: d.location?.span?.[0] ?? undefined,
        });
      }
    } else {
      // eslint: array of file results
      for (const file of Array.isArray(data) ? data : []) {
        for (const m of file.messages ?? []) {
          const sev = m.severity === 2 ? 'error' : m.severity === 1 ? 'warning' : 'info';
          issues.push({
            severity: sev,
            rule: m.ruleId ?? 'unknown',
            message: m.message ?? '',
            line: m.line,
          });
        }
      }
    }
  } catch {
    // parse error — treat as no issues
  }
  return issues;
}

/**
 * Apply a simple str_replace to file content, mirroring the `edit` tool.
 * If old_string appears multiple times, replaces the first occurrence.
 * Returns the modified content, or null if old_string wasn't found.
 */
function applyEdit(content: string, oldString: string, newString: string): string | null {
  const idx = content.indexOf(oldString);
  if (idx === -1) return null;
  return content.slice(0, idx) + newString + content.slice(idx + oldString.length);
}

/**
 * Filter issues by severity threshold.
 * "error" = only errors; "warning" = errors + warnings.
 */
function filterBySeverity(issues: LintIssue[], threshold: Severity): LintIssue[] {
  if (threshold === 'error') return issues.filter((i) => i.severity === 'error');
  return issues.filter((i) => i.severity === 'error' || i.severity === 'warning');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'lint-gate',
  version: '0.1.0',
  description: 'Pre-tool hook that runs biome/eslint on would-be file content before write or edit commits',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      linter: {
        type: 'string',
        enum: ['biome', 'eslint', 'auto'],
        default: 'auto',
        description: 'Which linter to use. "auto" tries biome first, then eslint.',
      },
      mode: {
        type: 'string',
        enum: ['block', 'warn', 'fix'],
        default: 'warn',
        description: '"block" refuses the write/edit; "warn" injects lint errors as context; "fix" auto-runs the linter with --write/--fix and substitutes the fixed content (write only; edit falls back to warn).',
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning'],
        default: 'error',
        description: 'Minimum severity to act on. "error" = only errors; "warning" = errors + warnings.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1000,
        default: 10000,
        description: 'Linter process timeout in milliseconds.',
      },
      fixRules: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'When mode=fix, only auto-fix issues matching these rule IDs (e.g. "lint/style/useImportType", "format"). Empty = fix everything the linter can.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.hitCount = 0;
    state.fixCount = 0;
    state.linterErrorCount = 0;
    state.hookUnregister = null;
    state.lastResult = null;

    const cfg = readConfig(api.config.extensions?.['lint-gate']);

    // Detect linter once at setup time.
    const linter = detectLinter(cfg.linter);
    if (!linter) {
      api.log.warn('lint-gate: no linter found (biome or eslint) — hook will be a no-op', {
        requested: cfg.linter,
      });
    } else {
      api.log.info('lint-gate: detected linter', { name: linter.name });
    }

    // PreToolUse hook: lint the would-be content before write/edit.
    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
    }): { decision?: 'block' | 'allow' | undefined; reason?: string; modifiedInput?: Record<string, unknown>; additionalContext?: string } | void => {
      if (!linter) return; // no linter → no-op

      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const filePath = inp['path'] as string | undefined;
      if (!filePath || typeof filePath !== 'string') return;

      state.invocationCount += 1;

      // Determine the would-be content.
      let content: string | null = null;
      if (toolName === 'write') {
        const c = inp['content'] as string | undefined;
        if (typeof c !== 'string') return;
        content = c;
      } else if (toolName === 'edit') {
        const oldStr = inp['old_string'] as string | undefined;
        const newStr = inp['new_string'] as string | undefined;
        if (typeof oldStr !== 'string' || typeof newStr !== 'string') return;
        // Read current file content, apply the edit in-memory.
        if (!existsSync(filePath)) return; // edit will fail anyway — let the tool handle it
        try {
          const current = readFileSync(filePath, 'utf-8');
          content = applyEdit(current, oldStr, newStr);
        } catch {
          return; // can't read file — let the tool handle the error
        }
        if (content === null) return; // old_string not found — edit will fail anyway
      } else {
        return; // not write or edit
      }

      // Run the linter.
      const issues = lintContent(content, filePath, linter, cfg.timeoutMs);
      if (issues === null) {
        state.linterErrorCount += 1;
        return; // linter process failed — don't block the write
      }

      const filtered = filterBySeverity(issues, cfg.severity);
      state.lastResult = {
        tool: toolName,
        path: filePath,
        issueCount: filtered.length,
        severities: [...new Set(filtered.map((i) => i.severity))],
        when: new Date().toISOString(),
      };

      if (filtered.length === 0) return; // clean — let it through

      // We have lint issues at or above the severity threshold.
      state.hitCount += 1;
      const summary = filtered
        .slice(0, 10) // cap at 10 to avoid massive context
        .map((i) => `  • [${i.severity}] ${i.rule}: ${i.message}${i.line ? ` (line ${i.line})` : ''}`)
        .join('\n');
      const truncated = filtered.length > 10 ? `\n  … and ${filtered.length - 10} more` : '';

      if (cfg.mode === 'block') {
        api.log.warn(`lint-gate: blocked ${toolName} on ${filePath} — ${filtered.length} issue(s)`, {
          severity: cfg.severity,
        });
        return {
          decision: 'block',
          reason:
            `lint-gate: ${filtered.length} linter issue(s) found in '${filePath}'. ` +
            `Fix them before writing:\n${summary}${truncated}`,
        };
      }

      if (cfg.mode === 'fix') {
        // Auto-fix only works for `write` — we can replace the entire
        // content. For `edit`, we can't safely re-derive the
        // new_string from a whole-file fix, so fall through to warn.
        if (toolName === 'write') {
          const fixedContent = lintAndFix(content, filePath, linter, cfg.timeoutMs);
          if (fixedContent !== content) {
            state.fixCount += 1;

            // If fixRules is set, check which issues REMAIN after the
            // fix. Issues NOT in fixRules are left as warnings — the
            // linter fixed what it could for the allowed rules, but
            // other issues persist.
            let remainingSummary = '';
            let remainingCount = 0;
            if (cfg.fixRules.length > 0) {
              const fixRuleSet = new Set(cfg.fixRules);
              const remaining = filtered.filter((i) => !fixRuleSet.has(i.rule));
              remainingCount = remaining.length;
              if (remaining.length > 0) {
                remainingSummary = remaining
                  .slice(0, 10)
                  .map((i) => `  • [${i.severity}] ${i.rule}: ${i.message}${i.line ? ` (line ${i.line})` : ''}`)
                  .join('\n');
              }
            }

            api.log.info(`lint-gate: auto-fixed ${filtered.length} issue(s) in ${filePath}`, {
              severity: cfg.severity,
              remaining: remainingCount,
            });
            return {
              decision: 'allow',
              modifiedInput: { ...inp, content: fixedContent },
              additionalContext:
                `\n✅ lint-gate: auto-fixed ${filtered.length} linter issue(s) in the content ` +
                `being written to '${filePath}'. The fixed content has been substituted automatically.` +
                (remainingCount > 0
                  ? `\n${remainingCount} issue(s) remain (not in fixRules):\n${remainingSummary}`
                  : ''),
            };
          }
          // Linter didn't change anything (unfixable rules) — fall
          // through to warn.
        }
        // edit or no fix applied — warn instead.
      }

      // mode === 'warn' — inject context but let the call through.
      api.log.info(`lint-gate: warning on ${toolName} for ${filePath} — ${filtered.length} issue(s)`, {
        severity: cfg.severity,
      });
      return {
        decision: 'allow',
        additionalContext:
          `\n⚠️ lint-gate: ${filtered.length} linter issue(s) detected in the content ` +
          `being written to '${filePath}'. Consider fixing:\n${summary}${truncated}`,
      };
    };

    state.hookUnregister = api.registerHook('PreToolUse', 'write|edit', hook);

    // --- lint_gate_status tool ---
    api.tools.register({
      name: 'lint_gate_status',
      description:
        'Reports lint-gate state: linter detected, mode, severity threshold, and per-session invocation/hit/error counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Code Quality',
      mutating: false,
      async execute() {
        return {
          ok: true,
          linter: linter?.name ?? 'none',
          mode: cfg.mode,
          severity: cfg.severity,
          timeoutMs: cfg.timeoutMs,
          fixRules: cfg.fixRules,
          counters: {
            invocations: state.invocationCount,
            hits: state.hitCount,
            fixes: state.fixCount,
            linterErrors: state.linterErrorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('lint-gate plugin loaded', {
      version: '0.1.0',
      linter: linter?.name ?? 'none',
      mode: cfg.mode,
      severity: cfg.severity,
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
      hits: state.hitCount,
      fixes: state.fixCount,
      linterErrors: state.linterErrorCount,
    };
    state.invocationCount = 0;
    state.hitCount = 0;
    state.fixCount = 0;
    state.linterErrorCount = 0;
    state.lastResult = null;
    api.log.info('lint-gate: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastResult === null
          ? `lint-gate: ${state.invocationCount} invocation(s), ${state.hitCount} hit(s)`
          : `lint-gate: last check on ${state.lastResult.path} — ${state.lastResult.issueCount} issue(s) at ${state.lastResult.when}`,
      counters: {
        invocations: state.invocationCount,
        hits: state.hitCount,
        fixes: state.fixCount,
        linterErrors: state.linterErrorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
