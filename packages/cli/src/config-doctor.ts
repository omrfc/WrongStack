/**
 * Config doctor — deterministic diagnosis and auto-repair for the standard
 * config file (~/.wrongstack/config.json and the per-project config).
 *
 * Pure module: `diagnoseConfig` never touches the filesystem. The /doctor
 * slash command owns file IO, backups, and persistence so the engine stays
 * trivially testable.
 *
 * Repair philosophy: a removed key is always safe — built-in defaults (and,
 * for `extensions`, each plugin's `defaultConfig`) are merged underneath user
 * values at load time, so deleting an invalid value falls back to a known-good
 * default. Values are only rewritten when the intent is unambiguous (e.g. the
 * string "true" for a boolean field); anything ambiguous is reported as a
 * non-fixable finding instead of guessed at.
 */

import type { JSONSchema } from '@wrongstack/core';
import { isSecretField, validateAgainstSchema } from '@wrongstack/core';
import {
  MAX_TUI_THINKING_WORD_LENGTH,
  normalizeTuiThinkingWord,
} from './tui-thinking-word.js';

export type DoctorSeverity = 'error' | 'warning';

export interface DoctorFinding {
  /** Dot path of the offending value, e.g. `autonomy.defaultMode`. */
  path: string;
  problem: string;
  severity: DoctorSeverity;
  /** Present when the finding is auto-fixable; describes the repair. */
  fix?: string | undefined;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  /** Deep copy of the input with every fixable finding repaired. */
  fixed: Record<string, unknown>;
  /** True when `fixed` differs from the input. */
  changed: boolean;
}

/** The subset of Plugin the doctor needs to validate `extensions` sections. */
export interface PluginSchemaInfo {
  name: string;
  configSchema?: JSONSchema | undefined;
}

/** Every key that may legitimately appear in a persisted config file.
 *  Mirrors the `Config` interface in @wrongstack/core types/config.ts. */
const KNOWN_TOP_LEVEL_KEYS = [
  'version',
  'provider',
  'model',
  'apiKey',
  'baseUrl',
  'maxConcurrent',
  'providers',
  'models',
  'modelMatrix',
  'context',
  'tools',
  'mcpServers',
  'fallbackModels',
  'fallbackAuto',
  'hooks',
  'plugins',
  'log',
  'features',
  'yolo',
  'nextPrediction',
  'cwd',
  'autonomy',
  'hints',
  'debugStream',
  'configScope',
  'indexing',
  'circuitBreaker',
  'adaptiveConcurrency',
  'launch',
  'session',
  'modelRuntime',
  'hq',
  'sync',
  'extensions',
] as const;

const BOOLEAN_FIELDS = ['hints', 'debugStream', 'yolo', 'nextPrediction'] as const;
const AUTONOMY_ENUMS: Record<string, readonly string[]> = {
  defaultMode: ['off', 'suggest', 'auto'],
  enhanceLanguage: ['original', 'english'],
};
const AUTONOMY_BOOLEANS = ['enhance'] as const;
const AUTONOMY_DELAYS = ['autoProceedDelayMs', 'enhanceDelayMs'] as const;

// Mirrors ENCRYPTED_PREFIX in core types/secret-vault.ts — vault-encrypted
// values carry this marker; anything else in a secret-named field is plaintext.
const ENC_PREFIX = 'enc:v1:';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'on' || v === 1) return true;
  if (v === 'false' || v === 'off' || v === 0) return false;
  return undefined;
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

export function diagnoseConfig(
  cfg: Record<string, unknown>,
  plugins: PluginSchemaInfo[] = [],
): DoctorReport {
  const fixed = structuredClone(cfg);
  const findings: DoctorFinding[] = [];

  // ── 1. Unknown top-level keys ─────────────────────────────────────────
  // Runs first so a case-typo'd key (e.g. "debugstream") is renamed before
  // the field checks below validate its value.
  for (const key of Object.keys(fixed)) {
    if ((KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(key)) continue;
    const match = KNOWN_TOP_LEVEL_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
    if (match && !(match in fixed)) {
      fixed[match] = fixed[key];
      delete fixed[key];
      findings.push({
        path: key,
        problem: `unknown key (did you mean "${match}"?)`,
        severity: 'error',
        fix: `renamed to "${match}"`,
      });
    } else {
      findings.push({
        path: key,
        problem: 'unknown key — left untouched (delete it manually if unwanted)',
        severity: 'warning',
      });
    }
  }

  // ── 2. version ────────────────────────────────────────────────────────
  if ('version' in fixed && fixed['version'] !== 1) {
    findings.push({
      path: 'version',
      problem: `expected 1, got ${JSON.stringify(fixed['version'])}`,
      severity: 'error',
      fix: 'set to 1',
    });
    fixed['version'] = 1;
  }

  // ── 3. Top-level booleans ─────────────────────────────────────────────
  for (const key of BOOLEAN_FIELDS) {
    if (!(key in fixed)) continue;
    const v = fixed[key];
    if (typeof v === 'boolean') continue;
    const coerced = coerceBoolean(v);
    if (coerced !== undefined) {
      fixed[key] = coerced;
      findings.push({
        path: key,
        problem: `expected boolean, got ${JSON.stringify(v)}`,
        severity: 'error',
        fix: `coerced to ${coerced}`,
      });
    } else {
      delete fixed[key];
      findings.push({
        path: key,
        problem: `expected boolean, got ${JSON.stringify(v)}`,
        severity: 'error',
        fix: 'removed (built-in default applies)',
      });
    }
  }

  // ── 4. configScope enum ───────────────────────────────────────────────
  if (
    'configScope' in fixed &&
    fixed['configScope'] !== 'global' &&
    fixed['configScope'] !== 'project'
  ) {
    findings.push({
      path: 'configScope',
      problem: `expected "global" or "project", got ${JSON.stringify(fixed['configScope'])}`,
      severity: 'error',
      fix: 'removed (defaults to global)',
    });
    delete fixed['configScope'];
  }

  // ── 5. maxConcurrent ──────────────────────────────────────────────────
  if ('maxConcurrent' in fixed) {
    const v = fixed['maxConcurrent'];
    const n = coerceNumber(v);
    if (n === undefined) {
      delete fixed['maxConcurrent'];
      findings.push({
        path: 'maxConcurrent',
        problem: `expected a non-negative integer, got ${JSON.stringify(v)}`,
        severity: 'error',
        fix: 'removed (built-in default applies)',
      });
    } else {
      const clamped = Math.max(0, Math.floor(n));
      if (clamped !== v) {
        fixed['maxConcurrent'] = clamped;
        findings.push({
          path: 'maxConcurrent',
          problem: `expected a non-negative integer, got ${JSON.stringify(v)}`,
          severity: 'error',
          fix: `set to ${clamped}`,
        });
      }
    }
  }

  // ── 6. provider / model must be strings (no safe auto-fix) ───────────
  for (const key of ['provider', 'model'] as const) {
    if (key in fixed && typeof fixed[key] !== 'string') {
      findings.push({
        path: key,
        problem: `expected string, got ${JSON.stringify(fixed[key])} — set it manually (e.g. /models)`,
        severity: 'error',
      });
    }
  }

  // ── 7. autonomy block ─────────────────────────────────────────────────
  if ('autonomy' in fixed) {
    if (!isPlainObject(fixed['autonomy'])) {
      findings.push({
        path: 'autonomy',
        problem: `expected object, got ${JSON.stringify(fixed['autonomy'])}`,
        severity: 'error',
        fix: 'removed (built-in defaults apply)',
      });
      delete fixed['autonomy'];
    } else {
      const autonomy = fixed['autonomy'];
      for (const [key, allowed] of Object.entries(AUTONOMY_ENUMS)) {
        if (key in autonomy && !allowed.includes(autonomy[key] as string)) {
          findings.push({
            path: `autonomy.${key}`,
            problem: `expected one of ${allowed.join('|')}, got ${JSON.stringify(autonomy[key])}`,
            severity: 'error',
            fix: 'removed (built-in default applies)',
          });
          delete autonomy[key];
        }
      }
      for (const key of AUTONOMY_BOOLEANS) {
        if (!(key in autonomy) || typeof autonomy[key] === 'boolean') continue;
        const coerced = coerceBoolean(autonomy[key]);
        findings.push({
          path: `autonomy.${key}`,
          problem: `expected boolean, got ${JSON.stringify(autonomy[key])}`,
          severity: 'error',
          fix:
            coerced !== undefined ? `coerced to ${coerced}` : 'removed (built-in default applies)',
        });
        if (coerced !== undefined) autonomy[key] = coerced;
        else delete autonomy[key];
      }
      for (const key of AUTONOMY_DELAYS) {
        if (!(key in autonomy)) continue;
        const v = autonomy[key];
        const n = coerceNumber(v);
        if (n === undefined) {
          findings.push({
            path: `autonomy.${key}`,
            problem: `expected a non-negative number (ms), got ${JSON.stringify(v)}`,
            severity: 'error',
            fix: 'removed (built-in default applies)',
          });
          delete autonomy[key];
        } else if (n < 0 || n !== v) {
          const repaired = Math.max(0, Math.round(n));
          findings.push({
            path: `autonomy.${key}`,
            problem: `expected a non-negative number (ms), got ${JSON.stringify(v)}`,
            severity: 'error',
            fix: `set to ${repaired}`,
          });
          autonomy[key] = repaired;
        }
      }
      if ('thinkingWord' in autonomy) {
        const normalized = normalizeTuiThinkingWord(autonomy.thinkingWord);
        if (autonomy.thinkingWord !== normalized) {
          findings.push({
            path: 'autonomy.thinkingWord',
            problem: `expected a single word up to ${MAX_TUI_THINKING_WORD_LENGTH} characters, got ${JSON.stringify(autonomy.thinkingWord)}`,
            severity: 'error',
            fix: 'removed (built-in default applies)',
          });
          delete autonomy.thinkingWord;
        }
      }
    }
  }

  // ── 8. plugins array ──────────────────────────────────────────────────
  if ('plugins' in fixed) {
    if (!Array.isArray(fixed['plugins'])) {
      findings.push({
        path: 'plugins',
        problem: `expected an array, got ${JSON.stringify(fixed['plugins'])}`,
        severity: 'error',
        fix: 'removed',
      });
      delete fixed['plugins'];
    } else {
      const entries = fixed['plugins'] as unknown[];
      const kept: unknown[] = [];
      entries.forEach((entry, i) => {
        if (typeof entry === 'string') {
          kept.push(entry);
          return;
        }
        if (isPlainObject(entry) && typeof entry['name'] === 'string') {
          if ('enabled' in entry && typeof entry['enabled'] !== 'boolean') {
            const coerced = coerceBoolean(entry['enabled']);
            findings.push({
              path: `plugins[${i}].enabled`,
              problem: `expected boolean, got ${JSON.stringify(entry['enabled'])}`,
              severity: 'error',
              fix: coerced !== undefined ? `coerced to ${coerced}` : 'removed',
            });
            if (coerced !== undefined) entry['enabled'] = coerced;
            else delete entry['enabled'];
          }
          if ('options' in entry && !isPlainObject(entry['options'])) {
            findings.push({
              path: `plugins[${i}].options`,
              problem: `expected object, got ${JSON.stringify(entry['options'])}`,
              severity: 'error',
              fix: 'removed',
            });
            delete entry['options'];
          }
          kept.push(entry);
          return;
        }
        findings.push({
          path: `plugins[${i}]`,
          problem: `expected a plugin name or { name, enabled?, options? }, got ${JSON.stringify(entry)}`,
          severity: 'error',
          fix: 'entry removed',
        });
      });
      if (kept.length !== entries.length) fixed['plugins'] = kept;
    }
  }

  // ── 9. extensions (plugin config sections) ───────────────────────────
  if ('extensions' in fixed) {
    if (!isPlainObject(fixed['extensions'])) {
      findings.push({
        path: 'extensions',
        problem: `expected an object of per-plugin sections, got ${JSON.stringify(fixed['extensions'])}`,
        severity: 'error',
        fix: 'removed',
      });
      delete fixed['extensions'];
    } else {
      const extensions = fixed['extensions'];
      for (const [name, value] of Object.entries(extensions)) {
        if (!isPlainObject(value)) {
          findings.push({
            path: `extensions.${name}`,
            problem: `expected object, got ${JSON.stringify(value)}`,
            severity: 'error',
            fix: 'removed',
          });
          delete extensions[name];
        }
      }
      // Validate each remaining section against its plugin's configSchema —
      // the exact validation the plugin loader runs before setup(). Invalid
      // options are removed; the plugin's defaultConfig fills the gap at load.
      for (const plugin of plugins) {
        const section = extensions[plugin.name];
        if (!plugin.configSchema || !isPlainObject(section)) continue;
        const result = validateAgainstSchema(section, plugin.configSchema);
        for (const err of result.errors) {
          const prop = err.path.split('.')[0]?.replace(/\[\d+\]$/, '');
          if (prop && prop !== '<root>' && prop in section) {
            findings.push({
              path: `extensions.${plugin.name}.${err.path}`,
              problem: err.message,
              severity: 'error',
              fix: `removed "${prop}" (plugin default applies)`,
            });
            delete section[prop];
          } else {
            findings.push({
              path: `extensions.${plugin.name}${err.path === '<root>' ? '' : `.${err.path}`}`,
              problem: err.message,
              severity: 'error',
            });
          }
        }
      }
    }
  }

  // ── 10. Plaintext secret scan (warning only — never rewrites values) ──
  scanPlaintextSecrets(fixed, '', findings);

  const changed = JSON.stringify(fixed) !== JSON.stringify(cfg);
  return { findings, fixed, changed };
}

function scanPlaintextSecrets(node: unknown, prefix: string, findings: DoctorFinding[]): void {
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      if (value.length > 0 && isSecretField(key) && !value.startsWith(ENC_PREFIX)) {
        findings.push({
          path,
          problem:
            'looks like a plaintext secret (not vault-encrypted) — it will be encrypted on next boot',
          severity: 'warning',
        });
      }
    } else if (isPlainObject(value)) {
      scanPlaintextSecrets(value, path, findings);
    }
  }
}
