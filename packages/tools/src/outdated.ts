import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { buildChildEnv } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';
import { safeResolve } from './_util.js';

interface OutdatedInput {
  cwd?: string;
  format?: 'list' | 'table';
  include_deprecated?: boolean;
  check?: string | string[];
}

interface OutdatedPackage {
  name: string;
  current: string;
  latest: string;
  wanted: string;
  type: string;
  location: string;
}

interface OutdatedOutput {
  exit_code: number;
  packages: OutdatedPackage[];
  total: number;
  output: string;
  truncated: boolean;
}

export const outdatedTool: Tool<OutdatedInput, OutdatedOutput> = {
  name: 'outdated',
  category: 'Package Management',
  description:
    'Check for outdated dependencies in the project. Reports current, wanted (semver range), and latest versions available.',
  usageHint:
    'MAINTENANCE & SECURITY TOOL:\n\n' +
    '- Run periodically or before dependency-related work.\n' +
    '- Helps surface packages that may need updates for security or features.\n' +
    '- Safe, read-only operation.\n' +
    'Use the output to decide on upgrades. Prefer this over manual shell commands for dependency hygiene.',
  permission: 'auto',
  mutating: false,
  timeoutMs: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      format: {
        type: 'string',
        enum: ['list', 'table'],
        description: 'Output format (default: list)',
      },
      include_deprecated: {
        type: 'boolean',
        description: 'Include deprecated packages (default: false)',
      },
      check: {
        type: 'string',
        description: 'Specific package(s) to check (comma-separated)',
      },
    },
  },
  async execute(input, ctx, opts) {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const manager = await detectManager(cwd);

    const args: string[] = ['outdated', '--json'];
    if (input.format === 'table') args.push('--table');
    if (input.include_deprecated) args.push('--include', 'deprecated');

    return runOutdated(manager, args, cwd, opts.signal);
  },
};

async function detectManager(cwd: string): Promise<string> {
  try {
    await stat(`${cwd}/pnpm-lock.yaml`);
    return 'pnpm';
  } catch {
    /* */
  }
  try {
    await stat(`${cwd}/yarn.lock`);
    return 'yarn';
  } catch {
    /* */
  }
  return 'npm';
}

function runOutdated(
  manager: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<OutdatedOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const MAX = 100_000;

    const child = spawn(manager, args, { cwd, signal, env: buildChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (c) => {
      if (stdout.length < MAX) stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      if (stderr.length < MAX) stderr += c.toString();
    });
    child.on('close', (code) => {
      const result = parseOutdatedOutput(stdout, code ?? 0);
      resolve(result);
    });
    child.on('error', (e) => {
      resolve({
        exit_code: 1,
        packages: [],
        total: 0,
        output: e.message,
        truncated: false,
      });
    });
  });
}

function parseOutdatedOutput(json: string, exitCode: number): OutdatedOutput {
  const packages: OutdatedPackage[] = [];

  if (!json) {
    return {
      exit_code: exitCode,
      packages: [],
      total: 0,
      output: exitCode === 0 ? 'All packages up to date' : 'Could not check outdated packages',
      truncated: false,
    };
  }

  try {
    const data = JSON.parse(json);
    for (const name of Object.keys(data)) {
      const info = data[name];
      packages.push({
        name,
        current: info.current ?? 'unknown',
        latest: info.latest ?? 'unknown',
        wanted: info.wanted ?? 'unknown',
        type: info.type ?? 'unknown',
        location: info.location ?? name,
      });
    }
  } catch {
    // JSON parse failed, return raw output
  }

  return {
    exit_code: exitCode,
    packages,
    total: packages.length,
    output: json,
    truncated: json.length >= 100_000,
  };
}
