import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gradePolyglot } from '../src/graders/polyglot-grader.js';
import type { PolyglotMeta } from '../src/suites/polyglot.js';
import type { BenchTask } from '../src/types.js';

let workdir: string;

beforeAll(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-grader-'));
  // A "test" that passes (exit 0) and one that fails (exit 1). Using plain
  // `node` keeps the grader test toolchain-free while exercising the exact
  // run-command + exit-code path the real grader uses.
  await fs.writeFile(path.join(workdir, 'pass.js'), 'process.exit(0)\n', 'utf8');
  await fs.writeFile(
    path.join(workdir, 'fail.js'),
    'console.log("AssertionError: 3 !== 4"); process.exit(1)\n',
    'utf8',
  );
});

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

function task(meta: Partial<PolyglotMeta>): BenchTask {
  const full: PolyglotMeta = {
    language: 'javascript',
    solutionFiles: ['solution.js'],
    testFiles: ['pass.js'],
    testCommand: { command: 'node', args: ['pass.js'] },
    ...meta,
  };
  return {
    id: 'polyglot/javascript/fixture',
    suite: 'polyglot',
    prompt: 'fixture',
    templateDir: workdir,
    meta: full as unknown as Record<string, unknown>,
  };
}

describe('gradePolyglot', () => {
  it('passes when the test command exits 0', async () => {
    const grade = await gradePolyglot({ workdir, task: task({}), timeoutMs: 30_000 });
    expect(grade.passed).toBe(true);
  });

  it('fails when the test command exits non-zero and captures detail', async () => {
    const grade = await gradePolyglot({
      workdir,
      task: task({ testCommand: { command: 'node', args: ['fail.js'] } }),
      timeoutMs: 30_000,
    });
    expect(grade.passed).toBe(false);
    expect(grade.detail).toContain('AssertionError');
  });

  it('fails with a setup error when the setup command fails', async () => {
    const grade = await gradePolyglot({
      workdir,
      task: task({ setupCommand: { command: 'node', args: ['-e', 'process.exit(7)'] } }),
      timeoutMs: 30_000,
    });
    expect(grade.passed).toBe(false);
    expect(grade.detail).toContain('setup failed');
  });
});
