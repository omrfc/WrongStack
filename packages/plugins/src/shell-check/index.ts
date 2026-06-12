/**
 * shell-check plugin — Runs shellcheck analysis on bash/shell scripts.
 *
 * Tools registered:
 * - shellcheck: Run shellcheck on specific files
 * - shellcheck_scan: Scan directory for shell script issues
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const API_VERSION = '^0.1.10';

interface ShellCheckIssue {
  file: string;
  line: number;
  column: number;
  level: 'error' | 'warning' | 'info' | 'style';
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// ShellCheck runner
// ---------------------------------------------------------------------------

function runShellCheck(
  files: string[],
  severity: 'error' | 'warning' | 'info' | 'style',
  cwd?: string | undefined,
): ShellCheckIssue[] {
  if (!existsSync('shellcheck')) {
    // Try to find shellcheck in PATH
    try {
      execSync('shellcheck --version', { encoding: 'utf-8', stdio: 'ignore', windowsHide: true });
    } catch {
      throw new Error('shellcheck is not installed. Install via: apt install shellcheck / brew install shellcheck');
    }
  }

  const levelMap: Record<string, string> = {
    error: 'error',
    warning: 'warning',
    info: 'info',
    style: 'style',
  };

  const args = [
    '-f', 'json',
    '-S', levelMap[severity] ?? 'warning',
    ...files,
  ];

  let raw: string;
  try {
    // Use execFileSync to avoid shell injection — filenames could contain
    // shell metacharacters like `; rm -rf /` if the LLM is tricked.
    raw = execFileSync('shellcheck', args, {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (err: unknown) {
    // shellcheck returns non-zero when issues are found, which is not an error
    const e = err as { stderr?: string | undefined };
    if (e.stderr && !e.stderr.includes('shellcheck')) {
      raw = e.stderr;
    } else {
      return [];
    }
  }

  if (!raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw) as Array<{
      file: string;
      line: number;
      column: number;
      level: string;
      code: string;
      message: string;
    }>;
    return parsed.map((item) => ({
      file: item.file,
      line: item.line,
      column: item.column,
      level: item.level as ShellCheckIssue['level'],
      code: item.code,
      message: item.message,
    }));
  } catch {
    return [];
  }
}

function findShellFiles(dir: string, pattern: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        results.push(...findShellFiles(full, pattern));
      } else if (entry.isFile() && (entry.name.endsWith('.sh') || entry.name === 'Dockerfile')) {
        if (!pattern || entry.name.includes(pattern)) {
          results.push(full);
        }
      }
    }
  } catch {
    // ignore access errors
  }
  return results;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'shell-check',
  version: '0.1.0',
  description: 'Runs shellcheck analysis on bash/shell scripts and surfaces issues with severity levels',
  apiVersion: API_VERSION,
  capabilities: { tools: true, pipelines: ['toolCall'] },
  defaultConfig: {
    severity: 'warning',
    severityThreshold: 'warning',
    ignoredCodes: [],
    autoScanOnBash: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['error', 'warning', 'info', 'style'], default: 'warning' },
      severityThreshold: { type: 'string', enum: ['error', 'warning', 'info', 'style'], default: 'warning' },
      ignoredCodes: { type: 'array', items: { type: 'string' }, default: [] },
      autoScanOnBash: { type: 'boolean', default: false },
    },
  },

  setup(api) {
    // --- shellcheck tool ---
    api.tools.register({
      name: 'shellcheck',
      description: 'Run shellcheck analysis on shell script files. Returns issues with file, line, column, severity, code, and message.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Shell script files to check',
          },
          severity: {
            type: 'string',
            enum: ['error', 'warning', 'info', 'style'],
            default: 'warning',
            description: 'Minimum severity level to report',
          },
          fix: {
            type: 'boolean',
            default: false,
            description: 'Apply safe automatic fixes where possible',
          },
        },
        required: ['files'],
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        const files = input['files'] as string[];
        const severity = (input['severity'] as ShellCheckIssue['level']) ?? 'warning';

        let issues: ShellCheckIssue[];
        try {
          issues = runShellCheck(files, severity);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: msg, issues: [] };
        }

        const byFile: Record<string, ShellCheckIssue[]> = {};
        for (const issue of issues) {
          if (byFile[issue.file] === undefined) {
            byFile[issue.file] = [];
          }
          byFile[issue.file]?.push(issue);
        }

        const errorCount = issues.filter((i) => i.level === 'error').length;
        const warningCount = issues.filter((i) => i.level === 'warning').length;
        const infoCount = issues.filter((i) => i.level === 'info').length;
        const styleCount = issues.filter((i) => i.level === 'style').length;

        api.metrics.counter('issues_found', issues.length, { severity });
        api.metrics.histogram('issues_per_file', issues.length / Math.max(files.length, 1));

        return {
          ok: true,
          filesScanned: files.length,
          issues,
          summary: {
            total: issues.length,
            errors: errorCount,
            warnings: warningCount,
            info: infoCount,
            style: styleCount,
          },
          byFile,
          recommendation: errorCount > 0
            ? 'Fix errors before deploying.'
            : warningCount > 0
              ? 'Review and fix warnings for better script quality.'
              : 'No issues found.',
        };
      },
    });

    // --- shellcheck_scan tool ---
    api.tools.register({
      name: 'shellcheck_scan',
      description: 'Recursively scan a directory for shell scripts and run shellcheck on all found files.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            default: '.',
            description: 'Directory to scan',
          },
          pattern: {
            type: 'string',
            default: '',
            description: 'Filename pattern to match (default: all .sh files)',
          },
          severity: {
            type: 'string',
            enum: ['error', 'warning', 'info', 'style'],
            default: 'warning',
          },
        },
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        const dir = (input['directory'] as string) ?? '.';
        const pattern = (input['pattern'] as string) ?? '';
        const severity = (input['severity'] as ShellCheckIssue['level']) ?? 'warning';

        const files = findShellFiles(dir, pattern);
        if (files.length === 0) {
          return { ok: true, filesScanned: 0, issues: [], summary: { total: 0 } };
        }

        let issues: ShellCheckIssue[];
        try {
          issues = runShellCheck(files, severity);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: msg, issues: [], filesScanned: 0 };
        }

        const byFile: Record<string, ShellCheckIssue[]> = {};
        for (const issue of issues) {
          if (byFile[issue.file] === undefined) {
            byFile[issue.file] = [];
          }
          byFile[issue.file]?.push(issue);
        }

        return {
          ok: true,
          filesScanned: files.length,
          filesWithIssues: Object.keys(byFile).length,
          issues,
          summary: {
            total: issues.length,
            errors: issues.filter((i) => i.level === 'error').length,
            warnings: issues.filter((i) => i.level === 'warning').length,
          },
          byFile,
        };
      },
    });

    api.log.info('shell-check plugin loaded', { version: '0.1.0' });
  },
};

export default plugin;