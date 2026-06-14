import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBenchmark } from '../src/orchestrate.js';
import type { BenchConfig, BenchSuite, BenchTask } from '../src/types.js';

let dir: string;
let fakeWstack: string;
let templateDir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-orch-'));

  // Fake wstack: emits a completed --output-json payload and exits. No network,
  // no real provider — we are testing the orchestration glue, not a model.
  fakeWstack = path.join(dir, 'fake-wstack.js');
  await fs.writeFile(
    fakeWstack,
    [
      'const out = { status: "completed", finalText: "ok", usage: { input: 100, output: 50, iterations: 3, cost: 0.01, elapsedMs: 10 } };',
      'process.stdout.write(JSON.stringify(out) + "\\n");',
    ].join('\n'),
    'utf8',
  );

  // A minimal task template (copied per task × cell).
  templateDir = path.join(dir, 'template');
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(path.join(templateDir, 'file.txt'), 'hello', 'utf8');
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeSuite(taskIds: string[]): BenchSuite {
  return {
    id: 'polyglot',
    async loadTasks({ limit }) {
      const tasks: BenchTask[] = taskIds.map((id) => ({
        id,
        suite: 'polyglot',
        prompt: `solve ${id}`,
        templateDir,
        meta: {},
      }));
      return limit === undefined ? tasks : tasks.slice(0, limit);
    },
    subsetId: (tasks) => `test:${tasks.map((t) => t.id).join(',')}`,
  };
}

const config: BenchConfig = {
  maxIterations: 10,
  concurrency: 2,
  timeoutMs: 30_000,
  cells: [
    { label: 'cellA', provider: 'p', model: 'm1' },
    { label: 'cellB', provider: 'p', model: 'm2' },
  ],
};

describe('runBenchmark', () => {
  it('fans out every (task × cell), grades, and folds into a fingerprinted report', async () => {
    const report = await runBenchmark({
      suite: makeSuite(['t1', 't2']),
      // Deterministic grader: tasks ending in "1" pass, others fail. The
      // workdir must exist (template was copied) — assert that too.
      grade: async ({ workdir, task }) => {
        const exists = await fs
          .stat(path.join(workdir, 'file.txt'))
          .then(() => true)
          .catch(() => false);
        return { passed: exists && task.id.endsWith('1') };
      },
      config,
      cliVersion: '0.255.0',
      toolNames: ['read', 'write', 'edit'],
      nodeBin: process.execPath,
      wstackEntry: fakeWstack,
      now: () => '2026-06-14T00:00:00.000Z',
    });

    // 2 tasks × 2 cells = 4 rows.
    expect(report.results).toHaveLength(4);
    expect(report.finishedAt).toBe('2026-06-14T00:00:00.000Z');
    expect(report.fingerprint.hash).toHaveLength(12);
    expect(report.fingerprint.subsetId).toBe('test:t1,t2');

    // Every run parsed the fake's usage block.
    for (const r of report.results) {
      expect(r.run.status).toBe('completed');
      expect(r.run.iterations).toBe(3);
    }

    // Each cell: t1 passes, t2 fails → 50% pass rate.
    expect(report.cells).toHaveLength(2);
    for (const cell of report.cells) {
      expect(cell.taskCount).toBe(2);
      expect(cell.passRate).toBe(0.5);
    }
  });

  it('respects the task limit', async () => {
    const report = await runBenchmark({
      suite: makeSuite(['t1', 't2', 't3']),
      grade: async () => ({ passed: true }),
      config: { ...config, cells: [{ label: 'only', provider: 'p', model: 'm' }] },
      cliVersion: '0.255.0',
      toolNames: [],
      nodeBin: process.execPath,
      wstackEntry: fakeWstack,
      limit: 2,
      now: () => 'fixed',
    });
    // 2 tasks (limited) × 1 cell = 2 rows.
    expect(report.results).toHaveLength(2);
  });

  it('throws a clear error when the suite yields no tasks', async () => {
    await expect(
      runBenchmark({
        suite: makeSuite([]),
        grade: async () => ({ passed: true }),
        config,
        cliVersion: '0.255.0',
        toolNames: [],
        nodeBin: process.execPath,
        wstackEntry: fakeWstack,
      }),
    ).rejects.toThrow(/no tasks/);
  });
});
