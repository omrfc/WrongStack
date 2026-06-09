import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core';
import type { Context, SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * Discover all `package.json` files in the project (root + workspace packages).
 * Returns relative paths for readable subagent task descriptions.
 */
async function discoverPackageFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  const rootPkg = path.join(projectRoot, 'package.json');
  try {
    await fs.access(rootPkg);
    files.push(rootPkg);
  } catch {
    // No package.json at root — not a Node project.
  }

  // Check pnpm workspace for additional packages
  const workspaceFile = path.join(projectRoot, 'pnpm-workspace.yaml');
  try {
    await fs.access(workspaceFile);
    const content = await fs.readFile(workspaceFile, 'utf8');
    // Simple YAML glob extraction: packages: ['packages/*', 'apps/*']
    const globMatch = /packages?:\s*\[([^\]]+)\]/s.exec(content);
    const rawGlobs = globMatch?.[1];
    if (!rawGlobs) return files;
    const globs = rawGlobs.split(/[\s,]+/).filter(Boolean).map((g) => g.replace(/['"]/g, ''));
    for (const g of globs) {
      // Convert glob to directory prefix and scan
      const dirPrefix = g.replace(/\/?\*$/, '').replace(/\/\*$/, '');
      const dir = path.join(projectRoot, dirPrefix);
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const subPkg = path.join(dir, e.name, 'package.json');
          try {
            await fs.access(subPkg);
            files.push(subPkg);
          } catch {
            // No package.json in this subdirectory.
          }
        }
      } catch {
        // Directory doesn't exist.
      }
    }
  } catch {
    // No workspace file.
  }

  return files;
}

/**
 * Build the subagent task description.
 *
 * The subagent is a general-purpose coding agent with access to the
 * `tech-stack` skill. The task tells it to scan, verify, and report.
 */
function buildTechStackTask(opts: {
  projectRoot: string;
  packageFiles: string[];
  outputFormat: 'md' | 'json';
  isInit: boolean;
}): string {
  const pkgList = opts.packageFiles
    .map((f) => `  - ${path.relative(opts.projectRoot, f)}`)
    .join('\n');

  const header = opts.isInit
    ? [
        '## Tech Stack Audit — First-Time Project Init',
        '',
        'This project is being initialized for the first time. Scan its dependencies,',
        'check every package and framework version against the npm registry, and produce',
        'a report that warns about outdated choices. The LLM that scaffolded this project',
        'may have suggested stale version numbers — verify every single one.',
        '',
      ].join('\n')
    : [
        '## Tech Stack Audit — Full Project Scan',
        '',
        'Scan all project dependencies, verify every package version against the npm',
        'registry, and produce a report that flags outdated, dead, or obsolete packages.',
        '',
      ].join('\n');

  const outputPath = opts.outputFormat === 'json' ? 'techstack.json' : 'techstack.md';

  return [
    header,
    '',
    '### Project package files to scan',
    `${pkgList || '  - package.json (root only)'}`,
    '',
    '### Instructions',
    '',
    '1. **Read** each package.json and extract ALL dependencies (dependencies +',
    '   devDependencies + peerDependencies). Include the workspace root.',
    '',
    '2. **For every dependency**, look up its latest version from the npm registry:',
    '   - `fetch("https://registry.npmjs.org/<package>/latest")`',
    '   - Extract the `version` field from the JSON response',
    '   - Also check `description`, `license`, and `time` fields for age/dead checks',
    '',
    '3. **For each package, determine status:**',
    '   - 🟢 CURRENT: installed version is within 1 minor of latest',
    '   - 🟡 OUTDATED: installed version is behind latest (major or >1 minor gap)',
    '   - 🔴 CRITICAL: package has known CVEs, is deprecated, or >2 years without release',
    '   - ☠️ DEAD: package is deprecated, archived, or superseded ≥5 years ago',
    '',
    '4. **Apply the tech-stack skill rules:**',
    '   - Reject packages that are "prehistoric" (superseded ≥5 years ago)',
    '   - Flag dead packages (no release >2 years + critical issues)',
    '   - Prefer Node.js built-ins over third-party packages',
    '',
    `5. **Write the report** to \`${outputPath}\` in the project root:`,
    '   - Markdown format: grouped by category, with version tables and warnings',
    '   - JSON format: structured array with name, current, latest, status, notes',
    '',
    '6. **Report a summary to chat**: total packages scanned, counts per status,',
    '   top 5 most urgent issues, and total cost estimate (optional).',
    '',
    '### Output format (markdown)',
    '',
    '```markdown',
    '# Tech Stack Report',
    '',
    'Generated: <date>  ·  Scanned: <total> packages across <N> files',
    '',
    '## 🟢 Up to Date (<count>)',
    '| Package | Current | Latest | Age | Notes |',
    '|---------|---------|--------|-----|-------|',
    '',
    '## 🟡 Outdated (<count>)',
    '...',
    '',
    '## 🔴 Critical Issues (<count>)',
    '...',
    '',
    '## ☠️ Dead / Obsolete (<count>)',
    '...',
    '',
    '## Recommendations',
    '- Top 3-5 actionable fixes',
    '```',
    '',
    '### Guardrails',
    '',
    '- Use `fetch()` with `AbortSignal.timeout(10000)` on every npm registry call.',
    '- Skip packages that return 404 (private/internal packages).',
    '- Deduplicate: same package in multiple package.json files = one row.',
    '- Do NOT modify any files except writing the report.',
    '- Run in 2-3 iterations max. Parallel fetch where possible.',
    '- **IMPORTANT**: Output the chat summary FIRST, then write the file. I need to see results.',
  ].join('\n');
}

export function buildTechStackCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'techstack',
    category: 'Inspect',
    aliases: ['tech', 'deps'],
    description:
      'Scan all project dependencies, verify versions against npm, and produce a techstack report.',
    argsHint: '[--json] [--init]',
    help: [
      'Usage:',
      '  /techstack              Scan dependencies + write techstack.md report',
      '  /techstack --json       Write techstack.json instead of markdown',
      '  /techstack --init       Init-mode scan (compares scaffolded vs latest)',
      '',
      'Spawns a subagent that:',
      '  1. Reads every package.json in the project',
      '  2. Looks up latest versions on the npm registry',
      '  3. Flags outdated, dead, or obsolete packages',
      `  4. Writes a ${color.cyan('techstack.md')} (or .json) report to the project root`,
      '',
      'Uses the `tech-stack` skill for version verification rules.',
      `Hooked into ${color.cyan('/init')} — runs automatically on first project setup.`,
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const trimmed = args.trim().toLowerCase();
      const outputFormat = /\b(--json|-j)\b/.test(trimmed) ? 'json' : 'md';
      const isInit = /\b(--init|-i)\b/.test(trimmed);

      // Discover package files before spawning
      let packageFiles: string[] = [];
      let discoveryNote = '';
      try {
        packageFiles = await discoverPackageFiles(opts.projectRoot);
        if (packageFiles.length === 0) {
          discoveryNote = color.amber(
            '⚠ No package.json files found. This does not look like a Node.js project.',
          );
        }
      } catch (err) {
        discoveryNote = color.red(
          `Could not scan for package files: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const task = buildTechStackTask({
        projectRoot: opts.projectRoot,
        packageFiles,
        outputFormat,
        isInit,
      });

      if (!opts.onSpawnAndWait) {
        const msg = 'Multi-agent is not enabled in this session. Cannot spawn techstack subagent.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      const header = isInit ? 'Tech Stack Init Audit' : 'Tech Stack Audit';
      const label = `${color.cyan('🔍')} ${color.bold(header)} ${color.dim(`(${packageFiles.length} package files)`)}`;
      opts.renderer.write(label);
      if (discoveryNote) opts.renderer.write(discoveryNote);

      opts.renderer.write(
        color.dim(`Spawning tech-stack subagent → writes ${outputFormat === 'json' ? 'techstack.json' : 'techstack.md'} when done.`),
      );

      try {
        const name = isInit ? 'techstack-init' : 'techstack-audit';
        const summary = await opts.onSpawnAndWait(task, { name });
        return { message: summary };
      } catch (err) {
        const msg = `Tech stack scan failed: ${err instanceof Error ? err.message : String(err)}`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }
    },
  };
}
