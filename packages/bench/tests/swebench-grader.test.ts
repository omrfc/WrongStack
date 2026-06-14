import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gradeSwebench } from '../src/graders/swebench-grader.js';
import { collectCellPredictions } from '../src/report/predictions.js';
import type { SwebenchMeta } from '../src/suites/swebench.js';
import type { Exec } from '../src/suites/swebench-patch.js';
import type { BenchTask, ModelCell } from '../src/types.js';

let dir: string;
const cell: ModelCell = { label: 'opus', provider: 'anthropic', model: 'claude-opus-4-8' };

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-swe-grade-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function task(meta: Partial<SwebenchMeta>): BenchTask {
  const full: SwebenchMeta = {
    instanceId: 'django__django-1',
    instanceDir: '/tmp/x',
    failToPass: ['test_a'],
    passToPass: ['test_b'],
    ...meta,
  };
  return {
    id: `swebench/${full.instanceId}`,
    suite: 'swebench',
    prompt: 'fix it',
    templateDir: '/tmp/x/repo',
    meta: full as unknown as Record<string, unknown>,
  };
}

/** Fake git that returns a fixed diff for `git diff --cached`. */
const fakeExec = (diff: string): Exec => {
  return async ({ args }) => {
    if (args[0] === 'diff') return { exitCode: 0, stdout: diff, stderr: '', timedOut: false };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
};

describe('gradeSwebench', () => {
  it('exports a prediction and marks the row ungraded when no inline grader is set', async () => {
    const predictionsDir = path.join(dir, 'p1');
    const grade = await gradeSwebench({
      workdir: '/tmp/x/repo',
      task: task({}),
      cell,
      timeoutMs: 30_000,
      predictionsDir,
      exec: fakeExec('diff --git a/src.py b/src.py\n+    return 2\n'),
    });
    expect(grade.passed).toBe(false);
    expect(grade.graded).toBe(false);
    expect(grade.detail).toContain('patch exported');

    const preds = await collectCellPredictions(predictionsDir, cell.label);
    expect(preds).toHaveLength(1);
    expect(preds[0]?.model_patch).toContain('return 2');
  });

  it('marks an empty patch as a genuine graded failure', async () => {
    const grade = await gradeSwebench({
      workdir: '/tmp/x/repo',
      task: task({}),
      cell,
      timeoutMs: 30_000,
      predictionsDir: path.join(dir, 'p2'),
      exec: fakeExec('   \n'),
    });
    expect(grade.passed).toBe(false);
    expect(grade.graded).toBe(true);
    expect(grade.detail).toContain('empty patch');
  });

  it('uses an inline grader verdict when provided', async () => {
    const grade = await gradeSwebench({
      workdir: '/tmp/x/repo',
      task: task({}),
      cell,
      timeoutMs: 30_000,
      predictionsDir: path.join(dir, 'p3'),
      exec: fakeExec('diff --git a/src.py b/src.py\n+ fix\n'),
      externalGrade: async ({ instanceId }) => instanceId === 'django__django-1',
    });
    expect(grade.graded).toBe(true);
    expect(grade.passed).toBe(true);
  });
});
