import * as path from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolve } from './_util.js';

interface TypecheckInput {
  project?: string;
  cwd?: string;
  strict?: boolean;
  all?: boolean;
}

interface TypecheckOutput {
  project: string;
  exit_code: number;
  errors: number;
  warnings: number;
  output: string;
  truncated: boolean;
}

export const typecheckTool: Tool<TypecheckInput, TypecheckOutput> = {
  name: 'typecheck',
  category: 'Code Quality',
  description:
    'Run TypeScript type checking with `tsc --noEmit`. Checks for type errors without compiling.',
  usageHint:
    'Set `project` for tsconfig path (default: nearest). `strict` enables strictest flags. `all` checks all projects in workspace.',
  permission: 'confirm',
  mutating: false,
  timeoutMs: 120_000,
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Path to tsconfig.json (default: auto-detect)' },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      strict: {
        type: 'boolean',
        description: 'Add --strict flag for maximum type checking (default: false)',
      },
      all: {
        type: 'boolean',
        description: 'Type-check all projects (pnpm -r) (default: false)',
      },
    },
  },
  async execute(input, ctx, opts) {
    let final: TypecheckOutput | undefined;
    for await (const ev of typecheckTool.executeStream!(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('typecheck: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<TypecheckOutput>> {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;

    let args: string[];
    let project: string;
    if (input.all) {
      args = ['--noEmit'];
      project = 'workspace';
    } else {
      const tsconfig = input.project ? safeResolve(input.project, ctx) : await findTsConfig(cwd);
      args = ['--noEmit'];
      if (input.strict) args.push('--strict');
      if (tsconfig) args.push('--project', tsconfig);
      project = tsconfig ?? 'default';
    }

    yield { type: 'log', text: `tsc ${args.join(' ')}`, data: { project } };

    const result = yield* spawnStream({
      cmd: 'npx',
      args: ['tsc', ...args],
      cwd,
      signal: opts.signal,
      maxBytes: 200_000,
    });

    const errors = (result.stdout.match(/error TS/g) || []).length;
    const warnings = (result.stdout.match(/warning/g) || []).length;

    yield {
      type: 'final',
      output: {
        project,
        exit_code: result.exitCode,
        errors,
        warnings,
        output: normalizeCommandOutput(result.stdout || result.stderr || result.error || ''),
        truncated: result.truncated,
      },
    };
  },
};

async function findTsConfig(cwd: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  const candidates = ['tsconfig.json', 'tsconfig.base.json'];
  for (const f of candidates) {
    try {
      const s = await stat(path.join(cwd, f));
      if (s.isFile()) return path.join(cwd, f);
    } catch {
      // continue
    }
  }
  return null;
}
