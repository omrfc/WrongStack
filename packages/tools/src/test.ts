import * as path from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolve } from './_util.js';

interface TestInput {
  files?: string | string[];
  runner?: 'vitest' | 'jest' | 'mocha' | 'auto';
  watch?: boolean;
  coverage?: boolean;
  cwd?: string;
  grep?: string;
  timeout?: number;
}

interface TestOutput {
  runner: string;
  exit_code: number;
  tests_run: number;
  passed: number;
  failed: number;
  duration_ms: number;
  output: string;
  truncated: boolean;
}

export const testTool: Tool<TestInput, TestOutput> = {
  name: 'test',
  category: 'Code Quality',
  description: 'Run tests with vitest, jest, or mocha. Returns pass/fail counts and output.',
  usageHint:
    'Set `files` for specific tests. `watch` enables watch mode. `coverage` generates coverage report. `grep` filters by name.',
  permission: 'confirm',
  mutating: false,
  timeoutMs: 120_000,
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'string',
        description: 'Test files: single path, comma-separated list, or glob (e.g. "**/*.test.ts")',
      },
      runner: {
        type: 'string',
        enum: ['vitest', 'jest', 'mocha', 'auto'],
        description: 'Test runner (default: auto-detect)',
      },
      watch: { type: 'boolean', description: 'Run in watch mode (default: false)' },
      coverage: { type: 'boolean', description: 'Generate coverage report (default: false)' },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      grep: { type: 'string', description: 'Filter tests by name pattern (default: none)' },
      timeout: { type: 'integer', description: 'Test timeout in ms (default: 30000)' },
    },
  },
  async execute(input, ctx, opts) {
    let final: TestOutput | undefined;
    for await (const ev of testTool.executeStream!(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('test: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<TestOutput>> {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const runner = input.runner ?? 'auto';

    const detected = runner === 'auto' ? await detectRunner(cwd) : runner;
    if (!detected) {
      yield {
        type: 'final',
        output: {
          runner: 'none',
          exit_code: 1,
          tests_run: 0,
          passed: 0,
          failed: 0,
          duration_ms: 0,
          output: 'No test runner found (vitest.config.ts, jest.config.js, .mocharc.json)',
          truncated: false,
        },
      };
      return;
    }

    yield { type: 'log', text: `Running ${detected}…`, data: { runner: detected } };

    const start = Date.now();
    const args = buildArgs(detected, input);

    const result = yield* spawnStream({
      cmd: detected,
      args,
      cwd,
      signal: opts.signal,
      maxBytes: 200_000,
    });
    const duration = Date.now() - start;

    yield { type: 'final', output: parseResult(detected, result, duration) };
  },
};

async function detectRunner(cwd: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  const candidates = ['vitest.config.ts', 'jest.config.js', '.mocharc.json'];
  for (const f of candidates) {
    try {
      await stat(path.join(cwd, f));
      if (f.includes('vitest')) return 'vitest';
      if (f.includes('jest')) return 'jest';
      if (f.includes('mocha')) return 'mocha';
    } catch {
      // continue
    }
  }
  return 'vitest';
}

function buildArgs(runner: string, input: TestInput): string[] {
  const args: string[] = [];
  const timeout = input.timeout ?? 30000;

  switch (runner) {
    case 'vitest':
      args.push('run', '--reporter=verbose');
      if (input.watch) {
        args[1] = '';
        args.push('watch');
      }
      if (input.coverage) args.push('--coverage');
      if (input.grep) args.push('--testNamePattern', input.grep);
      args.push('--testTimeout', String(timeout));
      break;
    case 'jest':
      args.push('--verbose');
      if (input.watch) args.push('--watch');
      if (input.coverage) args.push('--coverage');
      if (input.grep) args.push('--testPathPattern', input.grep);
      args.push('--testTimeout', String(timeout));
      break;
    case 'mocha':
      args.push('--reporter', 'spec');
      if (input.grep) args.push('--grep', input.grep);
      args.push('--timeout', String(timeout));
      break;
  }

  if (input.files) {
    const files = Array.isArray(input.files) ? input.files : input.files.split(',');
    args.push('--', ...files.map((f) => f.trim()));
  }

  return args;
}

function parseResult(
  runner: string,
  result: { stdout: string; stderr: string; exitCode: number; truncated: boolean; error?: string },
  duration: number,
): TestOutput {
  const out = result.stdout + result.stderr;

  let tests_run = 0;
  let passed = 0;
  let failed = 0;

  if (runner === 'vitest') {
    const passedMatch = out.match(/(\d+) passed/);
    const failedMatch = out.match(/(\d+) failed/);
    if (passedMatch?.[1]) passed = Number.parseInt(passedMatch[1], 10);
    if (failedMatch?.[1]) failed = Number.parseInt(failedMatch[1], 10);
    tests_run = passed + failed;
  } else if (runner === 'jest') {
    const suitesMatch = out.match(/Test Suites:\s+(\d+)\s+total/);
    const passedMatch = out.match(/Tests:\s+(\d+)\s+passed/);
    const failedMatch = out.match(/Tests:\s+(\d+)\s+failed/);
    tests_run = Number.parseInt(suitesMatch?.[1] ?? '0', 10);
    passed = Number.parseInt(passedMatch?.[1] ?? '0', 10);
    failed = Number.parseInt(failedMatch?.[1] ?? '0', 10);
  }

  return {
    runner,
    exit_code: result.exitCode,
    tests_run,
    passed,
    failed,
    duration_ms: duration,
    output: normalizeCommandOutput(result.stdout || result.error || ''),
    truncated: result.truncated,
  };
}
