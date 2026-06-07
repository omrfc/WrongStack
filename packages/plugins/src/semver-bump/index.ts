import { expectDefined } from '@wrongstack/core';
/**
 * semver-bump plugin — Conventional-commit-driven semver version bumps.
 *
 * Tools registered:
 * - semver_bump: Determine and apply the next version bump
 * - semver_current: Show the current version from package.json
 * - semver_changelog: Generate a changelog between two versions
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
const API_VERSION = '^0.1.10';

type BumpType = 'major' | 'minor' | 'patch' | 'auto';

interface ConventionalCommit {
  hash: string;
  type: string;
  scope?: string | undefined;
  message: string;
  breaking: boolean;
}

function runGit(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (err: unknown) {
    const e = err as { message?: string | undefined; stderr?: string | undefined; status?: number | undefined };
    if (e.status === 128) throw new Error('Not a git repository');
    throw new Error(`git failed: ${e.message ?? e.stderr ?? String(err)}`);
  }
}

function getPackageJson(cwd?: string): { version: string } | null {
  const path = cwd ? `${cwd}/package.json` : 'package.json';
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number.parseInt(expectDefined(m[1])), Number.parseInt(expectDefined(m[2])), Number.parseInt(expectDefined(m[3]))];
}

function bumpVersion(version: string, part: BumpType): string {
  let [major, minor, patch] = parseVersion(version);

  if (part === 'major') {
    major++;
    minor = 0;
    patch = 0;
  } else if (part === 'minor') {
    minor++;
    patch = 0;
  } else if (part === 'patch') {
    patch++;
  } else {
    return version; // auto requires commit analysis
  }

  return `${major}.${minor}.${patch}`;
}

function getRecentCommits(sinceTag?: string, cwd?: string): ConventionalCommit[] {
  const range = sinceTag ? `${sinceTag}..HEAD` : '-30';
  const output = runGit(['log', range, '--format=%H %s'], cwd);

  if (!output) return [];

  return output.split('\n').filter(Boolean).map((line) => {
    const spaceIdx = line.indexOf(' ');
    const hash = line.slice(0, spaceIdx);
    const message = line.slice(spaceIdx + 1);

    // Parse conventional commit
    const m = message.match(/^(\w+)(!)?(?:\(([^)]+)\))?:\s(.+)/);
    const type = m?.[1] ?? 'chore';
    const breaking = !!(m?.[2]);
    const scope = m?.[2];
    const msg = m?.[3] ?? message;

    return { hash, type, scope, message: msg, breaking };
  });
}

function determineBump(commits: ConventionalCommit[]): BumpType {
  for (const c of commits) {
    if (c.breaking || c.type === 'feat!:' || c.type === 'fix!') {
      return 'major';
    }
  }
  for (const c of commits) {
    if (c.type === 'feat' || c.type === 'refactor' && c.scope) {
      return 'minor';
    }
  }
  return 'patch';
}

function generateChangelog(commits: ConventionalCommit[]): string {
  const sections = {
    breaking: [] as ConventionalCommit[],
    feat: [] as ConventionalCommit[],
    fix: [] as ConventionalCommit[],
    perf: [] as ConventionalCommit[],
    docs: [] as ConventionalCommit[],
    refactor: [] as ConventionalCommit[],
    test: [] as ConventionalCommit[],
    chore: [] as ConventionalCommit[],
    other: [] as ConventionalCommit[],
  };
  type SectionKey = keyof typeof sections;

  for (const c of commits) {
    if (c.breaking) {
      sections.breaking.push(c);
    } else if (c.type in sections) {
      sections[c.type as SectionKey].push(c);
    } else {
      sections.other.push(c);
    }
  }

  const lines: string[] = ['# Changelog\n'];

  if (sections.breaking.length > 0) {
    lines.push('## ⚠️ BREAKING CHANGES\n');
    for (const c of sections.breaking) {
      lines.push(`- **${c.hash.slice(0, 7)}** ${c.message} (${c.type})`);
    }
    lines.push('');
  }

  const ordered = ['feat', 'fix', 'perf', 'docs', 'refactor', 'test', 'chore', 'other'] as const;
  const labels: Record<SectionKey, string> = {
    breaking: 'Breaking',
    feat: 'Features',
    fix: 'Bug Fixes',
    perf: 'Performance',
    docs: 'Documentation',
    refactor: 'Refactoring',
    test: 'Tests',
    chore: 'Chores',
    other: 'Other Changes',
  };

  for (const key of ordered) {
    const items = sections[key];
    if (items.length === 0) continue;
    lines.push(`## ${labels[key]}\n`);
    for (const c of items) {
      const scope = c.scope ? `**${c.scope}**: ` : '';
      lines.push(`- **${c.hash.slice(0, 7)}** ${scope}${c.message}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'semver-bump',
  version: '0.1.0',
  description: 'Conventional-commit-driven semver version bumps with changelog generation',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    tagPrefix: 'v',
    changelogFile: 'CHANGELOG.md',
    autoTag: true,
    tagMessage: 'Release {{version}}',
  },
  configSchema: {
    type: 'object',
    properties: {
      tagPrefix: { type: 'string', default: 'v' },
      changelogFile: { type: 'string', default: 'CHANGELOG.md' },
      autoTag: { type: 'boolean', default: true },
      tagMessage: { type: 'string', default: 'Release {{version}}' },
    },
  },

  setup(api) {
    const tagPrefix = (api.config.extensions?.['semver-bump'] as Record<string, unknown>)?.['tagPrefix'] as string ?? 'v';
    const autoTag = (api.config.extensions?.['semver-bump'] as Record<string, unknown>)?.['autoTag'] as boolean ?? true;

    // --- semver_bump ---
    api.tools.register({
      name: 'semver_bump',
      description: 'Determine the next version bump from conventional commits since the last tag, or force a specific bump. Creates a git tag.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Working directory (defaults to project root)' },
          dryRun: { type: 'boolean', default: false },
          part: { type: 'string', enum: ['major', 'minor', 'patch', 'auto'], default: 'auto', description: 'Version part to bump (auto = infer from commits)' },
        },
      },
      permission: 'confirm',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        const cwd = input['cwd'] as string | undefined;
        const dryRun = (input['dryRun'] as boolean | undefined) ?? false;
        const part = (input['part'] as BumpType) ?? 'auto';

        // Get current version
        const pkg = getPackageJson(cwd);
        if (!pkg) {
          return { ok: false, error: 'No package.json found' };
        }

        const currentVersion = pkg.version;

        // Determine bump
        let bumpPart: BumpType = part;
        let commits: ConventionalCommit[] = [];

        if (part === 'auto') {
          // Find last tag
          let lastTag: string | undefined;
          try {
            const tagsOutput = runGit(['describe', '--tags', '--abbrev=0'], cwd);
            lastTag = tagsOutput || undefined;
          } catch {
            // No tags yet — use empty commit list
          }

          try {
            commits = getRecentCommits(lastTag, cwd);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `Git error: ${msg}`, bumpPart: 'patch' };
          }
          bumpPart = determineBump(commits);
        } else {
          bumpPart = part;
        }

        const newVersion = bumpVersion(currentVersion, bumpPart);

        if (dryRun) {
          return {
            ok: true,
            dryRun: true,
            currentVersion,
            suggestedBump: bumpPart,
            newVersion,
            commitCount: part === 'auto' ? commits.length : undefined,
            message: `Would bump ${currentVersion} → ${newVersion} (${bumpPart})`,
          };
        }

        // Actually apply the bump
        // 1. Update package.json version
        const fs = await import('node:fs');
        const pkgPath = cwd ? `${cwd}/package.json` : 'package.json';
        const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        pkgData.version = newVersion;
        fs.writeFileSync(pkgPath, JSON.stringify(pkgData, null, 2) + '\n', 'utf-8');

        // 2. Git commit the version bump
        try {
          runGit(['add', 'package.json'], cwd);
          runGit(['commit', '-m', `chore: bump version to ${newVersion}`], cwd);
        } catch {
          // commit might fail if nothing changed, that's OK
        }

        // 3. Create git tag
        if (autoTag) {
          try {
            runGit(['tag', '-a', `${tagPrefix}${newVersion}`, '-m', `Release ${newVersion}`], cwd);
          } catch {
            // tag might already exist
          }
        }

        api.log.info('semver-bump: bumped', { from: currentVersion, to: newVersion, bump: bumpPart });
        api.metrics.counter('version_bump', 1, { bump: bumpPart });

        await api.session.append({
          type: 'semver-bump:bumped',
          ts: new Date().toISOString(),
          from: currentVersion,
          to: newVersion,
          bump: bumpPart,
        });

        return {
          ok: true,
          currentVersion,
          newVersion,
          bump: bumpPart,
          tag: `${tagPrefix}${newVersion}`,
          message: `Bumped ${currentVersion} → ${newVersion} (${bumpPart})`,
        };
      },
    });

    // --- semver_current ---
    api.tools.register({
      name: 'semver_current',
      description: 'Return the current version from package.json and the latest git tag.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Working directory' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const cwd = input['cwd'] as string | undefined;

        const pkg = getPackageJson(cwd);
        const currentVersion = pkg?.version ?? 'unknown';

        let latestTag: string | null = null;
        let commitsSinceTag = 0;
        try {
          const tagsOutput = runGit(['describe', '--tags', '--abbrev=0'], cwd);
          latestTag = tagsOutput || null;

          if (latestTag) {
            const countOutput = runGit(['rev-list', '--count', `${latestTag}..HEAD`], cwd);
            commitsSinceTag = Number.parseInt(countOutput) || 0;
          }
        } catch {
          latestTag = null;
        }

        return {
          ok: true,
          currentVersion,
          latestTag: latestTag ?? null,
          tagPrefix,
          commitsSinceTag,
        };
      },
    });

    // --- semver_changelog ---
    api.tools.register({
      name: 'semver_changelog',
      description: 'Generate a changelog (in markdown) between two version tags or from a tag to HEAD.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Starting tag (exclusive)' },
          to: { type: 'string', description: 'Ending tag or "HEAD"' },
          cwd: { type: 'string', description: 'Working directory' },
          format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const from = input['from'] as string | undefined;
        const to = input['to'] as string ?? 'HEAD';
        const cwd = input['cwd'] as string | undefined;
        const format = (input['format'] as 'markdown' | 'json') ?? 'markdown';

        const range = from ? `${from}..${to}` : to;

        let commits: ConventionalCommit[];
        try {
          const output = runGit(['log', range === to ? '-30' : range, '--format=%H %s'], cwd);
          commits = output.split('\n').filter(Boolean).map((line) => {
            const spaceIdx = line.indexOf(' ');
            const hash = line.slice(0, spaceIdx);
            const message = line.slice(spaceIdx + 1);
            const m = message.match(/^(\w+)(!)?(?:\(([^)]+)\))?:\s(.+)/);
            const type = m?.[1] ?? 'chore';
            return {
              hash,
              type,
              scope: m?.[2],
              message: m?.[3] ?? message,
              breaking: !!(m?.[2]),
            };
          });
        } catch (err: unknown) {
          return { ok: false, error: `Failed to get git log: ${err}` };
        }

        if (format === 'json') {
          return {
            ok: true,
            from,
            to,
            commits,
            commitCount: commits.length,
          };
        }

        const changelog = generateChangelog(commits);

        return {
          ok: true,
          from: from ?? '(beginning)',
          to,
          changelog,
          commitCount: commits.length,
          breakingCount: commits.filter((c) => c.breaking).length,
        };
      },
    });

    api.log.info('semver-bump plugin loaded', { version: '0.1.0', tagPrefix, autoTag });
  },
};

export default plugin;