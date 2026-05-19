import type { SlashCommand } from '../types/slash-command.js';
import type { Context } from '../core/context.js';
import { defaultOrchestrator } from './orchestrator.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function createSecuritySlashCommand(): SlashCommand {
  return {
    name: 'security',
    description: 'Security scanning commands: scan, audit, report',
    argsHint: '[scan|audit|report] [options]',
    help: `
# /security — Security Scanner

Security scanning with automatic tech stack detection.

## Commands

### /security scan [options]
Run a full security scan on the current project.
Options:
  --depth quick|standard|deep  Scan depth (default: standard)
  --format markdown|json|html   Report format (default: markdown)

### /security audit
Run dependency audit + security scan.
Checks for known vulnerabilities in dependencies.

### /security report [id]
Show a previous security report.
  /security report          - List available reports
  /security report <id>     - Show specific report

## Examples

/security scan
/security scan --depth deep --format html
/security audit
/security report
/security report 2025-01-15
`,
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || '';
      const subArgs = parts.slice(1).join(' ');

      switch (subcommand) {
        case 'scan':
          return handleScan(subArgs, ctx);
        case 'audit':
          return handleAudit(ctx);
        case 'report':
          return handleReport(subArgs);
        default:
          return { message: getHelpMessage() };
      }
    },
  };
}

async function handleScan(args: string, ctx: Context): Promise<{ message?: string; metadata?: Record<string, unknown> }> {
  const options = parseArgs(args);
  const projectRoot = ctx.projectRoot || ctx.cwd || process.cwd();

  try {
    // Pass ctx (with provider) to orchestrator for LLM access
    const result = await defaultOrchestrator.run(ctx, {
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

    // Use LLM-synthesized report if available, otherwise use basic summary
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

async function handleAudit(ctx: Context): Promise<{ message?: string; metadata?: Record<string, unknown> }> {
  const projectRoot = ctx.projectRoot || ctx.cwd || process.cwd();

  try {
    const result = await defaultOrchestrator.run(ctx, {
      projectRoot,
      reportOptions: { format: 'markdown' },
    });

    const depIssues = result.scanResult.summary.critical + result.scanResult.summary.high;

    // Use LLM-synthesized report for audit
    const reportContent = result.synthesizedReport || `
# Security Audit Complete

**Project:** ${projectRoot}
**Tech Stack:** ${result.detectionResult.detectedStacks[0]?.stack || 'unknown'}

## Dependency Health

| Status | Count |
|--------|-------|
| Critical Issues | ${result.scanResult.summary.critical} |
| High Priority | ${result.scanResult.summary.high} |
| Medium Priority | ${result.scanResult.summary.medium} |
| Low Priority | ${result.scanResult.summary.low} |

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
      // List all reports
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

    // Show specific report
    const index = parseInt(reportId, 10) - 1;
    if (!isNaN(index) && reports[index]) {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(reportsDir, reports[index]), 'utf-8');
      return { message: `# Security Report\n\n${content}` };
    }

    // Try to find by ID/date
    const match = reports.find((r) => r.includes(reportId));
    if (match) {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(reportsDir, match), 'utf-8');
      return { message: `# Security Report\n\n${content}` };
    }

    return { message: `❌ Report "${reportId}" not found. Use \`/security report\` to see available reports.` };
  } catch (error) {
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
  return `
# /security — Security Scanner

**Available Commands:**

1. **/security scan** — Run full security scan
   Options: --depth quick|standard|deep, --format markdown|json|html

2. **/security audit** — Run dependency audit + security scan

3. **/security report** — List or view security reports

**Examples:**
\`\`\`
/security scan
/security scan --depth deep --format html
/security audit
/security report
\`\`\`
`;
}

export const securitySlashCommand = createSecuritySlashCommand();