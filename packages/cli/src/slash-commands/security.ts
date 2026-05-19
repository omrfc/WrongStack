import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlashCommand, Context, Provider } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { defaultOrchestrator } from '@wrongstack/core';

/** Accepts a full Context (active agent run) or just provider+model (pre-agent session). */
type SecurityScannerContext = Context | { provider: Provider; model?: string };

export function buildSecurityCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'security',
    description: 'Security scanning: scan, audit, report',
    argsHint: '[scan|audit|report] [options]',
    help: `
# /security — Security Scanner

Automated security scanning with tech stack detection.

## Commands

### /security scan [options]
Run a full security scan on the current project.
Options:
  --depth quick|standard|deep  Scan depth (default: standard)
  --format markdown|json|html  Report format (default: markdown)

### /security audit
Run dependency audit + security scan.

### /security report [id]
List or view security reports.

## Examples

/security scan
/security scan --depth deep --format html
/security audit
/security report
`,
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || '';

      switch (subcommand) {
        case 'scan':
          return handleScan(parts.slice(1).join(' '), ctx, opts);
        case 'audit':
          return handleAudit(ctx, opts);
        case 'report':
          return handleReport(parts[1] || '');
        default:
          return { message: getHelpMessage() };
      }
    },
  };
}

async function handleScan(args: string, ctx: Context, opts: SlashCommandContext): Promise<{ message?: string; metadata?: Record<string, unknown> }> {
  const options = parseArgs(args);
  const projectRoot = ctx.projectRoot || opts.projectRoot;

  try {
    // Use active context if available, otherwise fall back to direct provider access
    const orchestratorContext: SecurityScannerContext = ctx.provider ? ctx : { provider: opts.llmProvider!, model: opts.llmModel };

    if (!orchestratorContext.provider) {
      return { message: '❌ Security scan requires an active LLM provider. No provider configured.' };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (defaultOrchestrator.run as any)(orchestratorContext, {
      projectRoot,
      scanOptions: {
        depth: (options.depth as 'quick' | 'standard' | 'deep') || 'standard',
        includeSecrets: true,
        includeInjection: true,
        includeConfig: true,
      },
      reportOptions: {
        format: (options.format as 'markdown' | 'json' | 'html') || 'markdown',
      },
    });

    const summary = result.scanResult.summary;
    const status = summary.total === 0 ? '✅ No issues found' : `⚠️ Found ${summary.total} issues`;

    // Use LLM-synthesized report if available
    const reportContent = result.synthesizedReport || `# Security Scan Complete

**Project:** ${projectRoot}
**Tech Stack:** ${result.detectionResult.detectedStacks[0]?.stack || 'unknown'}
**Scanned Files:** ${result.scanResult.scannedFiles}
**Duration:** ${result.scanResult.scanDurationMs}ms

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | ${summary.critical} |
| 🟠 High | ${summary.high} |
| 🟡 Medium | ${summary.medium} |
| 🟢 Low | ${summary.low} |

**Status:** ${status}

**Report:** ${result.reportPath}
`;

    return {
      message: reportContent,
      metadata: {
        scanResult: result.scanResult,
        reportPath: result.reportPath,
        techStack: result.detectionResult.detectedStacks[0],
      },
    };
  } catch (error) {
    return { message: `❌ Scan failed: ${error}` };
  }
}

async function handleAudit(ctx: Context, opts: SlashCommandContext): Promise<{ message?: string; metadata?: Record<string, unknown> }> {
  const projectRoot = ctx.projectRoot || opts.projectRoot;

  try {
    // Use active context if available, otherwise fall back to direct provider access
    const orchestratorContext: SecurityScannerContext = ctx.provider ? ctx : { provider: opts.llmProvider!, model: opts.llmModel };

    if (!orchestratorContext.provider) {
      return { message: '❌ Security audit requires an active LLM provider. No provider configured.' };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (defaultOrchestrator.run as any)(orchestratorContext, {
      projectRoot,
      reportOptions: { format: 'markdown' },
    });

    const summary = result.scanResult.summary;
    const depIssues = summary.critical + summary.high;

    // Use LLM-synthesized report for audit
    const reportContent = result.synthesizedReport || `# Security Audit Complete

**Project:** ${projectRoot}
**Tech Stack:** ${result.detectionResult.detectedStacks[0]?.stack || 'unknown'}

## Dependency Health

| Status | Count |
|--------|-------|
| Critical Issues | ${summary.critical} |
| High Priority | ${summary.high} |
| Medium Priority | ${summary.medium} |
| Low Priority | ${summary.low} |

${depIssues === 0 ? '✅ No known vulnerabilities detected' : `⚠️ ${depIssues} vulnerabilities need attention`}

**Full Report:** ${result.reportPath}
`;

    return {
      message: reportContent,
      metadata: {
        scanResult: result.scanResult,
        reportPath: result.reportPath,
      },
    };
  } catch (error) {
    return { message: `❌ Audit failed: ${error}` };
  }
}

async function handleReport(reportId: string): Promise<{ message?: string }> {
  const reportsDir = 'security-reports';

  try {
    const files = await readdir(reportsDir);
    const reports = files
      .filter((f) => f.startsWith('security-report-') && (f.endsWith('.md') || f.endsWith('.json')))
      .sort()
      .reverse();

    if (!reportId) {
      if (reports.length === 0) {
        return { message: '📭 No security reports found. Run `/security scan` first.' };
      }

      const list = reports
        .map((r, i) => {
          const date = r.replace('security-report-', '').replace(/\.(md|json)$/, '');
          return `  ${i + 1}. ${date}`;
        })
        .join('\n');

      return { message: `# Available Security Reports\n\n${list}\n\nUse \`/security report <number>\` to view a specific report.` };
    }

    const index = parseInt(reportId, 10) - 1;
    if (!isNaN(index) && reports[index]) {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(reportsDir, reports[index]), 'utf-8');
      return { message: `# Security Report\n\n${content}` };
    }

    const match = reports.find((r) => r.includes(reportId));
    if (match) {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(reportsDir, match), 'utf-8');
      return { message: `# Security Report\n\n${content}` };
    }

    return { message: `❌ Report "${reportId}" not found. Use \`/security report\` to see available reports.` };
  } catch {
    return { message: '📭 No security reports found. Run `/security scan` first.' };
  }
}

function parseArgs(args: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = args.split(/\s+/);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || !part.startsWith('--')) continue;

    const key = part.slice(2);
    const next = parts[i + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      i++;
    } else {
      result[key] = 'true';
    }
  }

  return result;
}

function getHelpMessage(): string {
  return `# /security — Security Scanner

**Available Commands:**

1. **/security scan** — Run full security scan
   \`/security scan --depth deep --format html\`

2. **/security audit** — Run dependency audit + security scan

3. **/security report** — List available reports

**Features:**
- Automatic tech stack detection
- Dynamic security skill generation
- Secrets, injection, and config vulnerability scanning
- Markdown/JSON/HTML reports
- .gitignore auto-update

Run \`/security scan\` to start.`;
}