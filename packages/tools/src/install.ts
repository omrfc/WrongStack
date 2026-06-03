import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { spawnStream } from './_spawn-stream.js';
import { detectPackageManager, normalizeCommandOutput, safeResolve } from './_util.js';

interface InstallInput {
  packages?: string | string[];
  save?: 'dependency' | 'dev' | 'optional';
  cwd?: string;
  dry_run?: boolean;
  global?: boolean;
}

interface InstallOutput {
  packages: string[];
  exit_code: number;
  output: string;
  dry_run: boolean;
  truncated: boolean;
}

export const installTool: Tool<InstallInput, InstallOutput> = {
  name: 'install',
  category: 'Package Management',
  description:
    'Install, update or manage packages using the detected package manager (pnpm/npm/yarn). ' +
    'Strongly preferred over raw shell commands for dependency management because it is structured and safer.',
  usageHint:
    'ALWAYS USE THIS INSTEAD OF BASH FOR PACKAGE WORK:\n\n' +
    '- Empty `packages` → normal `install` (respects lockfile).\n' +
    '- Provide names → adds/updates specific packages.\n' +
    '- `dry_run: true` for safe preview.\n' +
    '- Set `save` appropriately.\n' +
    'This tool has proper capability declaration and is heavily recommended in the security posture of the project.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: 120_000,
  capabilities: ['package.install', 'shell.restricted'],
  inputSchema: {
    type: 'object',
    properties: {
      packages: {
        type: 'string',
        description:
          'Package(s) to install: single name, comma-separated list, or empty for all deps',
      },
      save: {
        type: 'string',
        enum: ['dependency', 'dev', 'optional'],
        description: 'Where to save the package(s): "dependency", "devDependencies", or "optionalDependencies".',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the install command (must stay inside project).',
      },
      dry_run: {
        type: 'boolean',
        description: 'If true, show what would be installed without actually modifying package.json or node_modules.',
      },
      global: {
        type: 'boolean',
        description: 'Whether to perform a global install (use with caution).',
      },
    },
  },
  async execute(input, ctx, opts) {
    let final: InstallOutput | undefined;
    for await (const ev of installTool.executeStream!(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('install: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<InstallOutput>> {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const pkgManager = await detectPackageManager(cwd);
    yield { type: 'log', text: `Resolving with ${pkgManager}…`, data: { phase: 'resolve' } };

    const save = input.save === 'dev' ? '-D' : input.save === 'optional' ? '-O' : '';
    const globalFlag = input.global ? ['-g'] : [];

    const args: string[] = [];
    if (input.dry_run) args.push('--dry-run');
    if (pkgManager === 'pnpm') {
      if (save) args.push(save);
      args.push('add', ...globalFlag);
    } else if (pkgManager === 'yarn') {
      args.push('add', ...globalFlag);
    } else {
      args.push('install', ...globalFlag);
    }

    const pkgList = input.packages
      ? (Array.isArray(input.packages) ? input.packages : input.packages.split(',')).map((p) =>
          p.trim(),
        )
      : [];

    // Validate package names to prevent flag injection and path traversal.
    // A name like "--ignore-scripts=false" would be interpreted as a flag;
    // "file:../../etc/passwd" as a local path specifier.
    // Cap at 200 chars to prevent ReDoS on the regex engine (npm's max is 214).
    const PKG_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
    for (const pkg of pkgList) {
      if (!PKG_NAME_RE.test(pkg) || pkg.startsWith('-') || pkg.length > 200) {
        yield {
          type: 'final',
          output: {
            packages: pkgList,
            exit_code: 1,
            output: `Invalid package name "${pkg}". Names must match ${PKG_NAME_RE} and not start with "-".`,
            dry_run: Boolean(input.dry_run),
            truncated: false,
          },
        };
        return;
      }
    }

    if (pkgList.length > 0) args.push(...pkgList);

    yield {
      type: 'log',
      text: `Fetching ${pkgList.length || 'all'} packages…`,
      data: { phase: 'fetch' },
    };

    const result = yield* spawnStream({
      cmd: pkgManager,
      args,
      cwd,
      signal: opts.signal,
      maxBytes: 100_000,
    });

    yield {
      type: 'final',
      output: {
        packages: pkgList,
        exit_code: result.exitCode,
        output: normalizeCommandOutput(result.stdout || result.stderr || result.error || ''),
        dry_run: args.includes('--dry-run'),
        truncated: result.truncated,
      },
    };
  },
};

