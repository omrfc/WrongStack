import { writeInstancePrediction } from '../report/predictions.js';
import type { SwebenchMeta } from '../suites/swebench.js';
import { type Exec, extractModelPatch } from '../suites/swebench-patch.js';
import type { BenchTask, GradeResult, ModelCell } from '../types.js';

/**
 * Inline (Docker) grader hook. Given an instance's model patch and held-out
 * test data, return whether the issue is resolved — or `undefined` if it could
 * not produce a verdict. Left injectable so the heavy, version-sensitive Docker
 * execution is plugged in by the host (the official SWE-bench harness) rather
 * than re-implemented and guessed-at here.
 */
export type SwebenchExternalGrade = (args: {
  instanceId: string;
  patch: string;
  image?: string | undefined;
  failToPass: string[];
  passToPass: string[];
  testPatch?: string | undefined;
  workdir: string;
  timeoutMs: number;
}) => Promise<boolean | undefined>;

/**
 * SWE-bench grader.
 *
 * Resolution is decided deterministically by the instance's own tests
 * (`FAIL_TO_PASS` must pass, `PASS_TO_PASS` must still pass) inside its pinned
 * Docker image — never an LLM. We do NOT re-implement that Docker evaluation
 * (the official `princeton-nlp/SWE-bench` harness owns it and it is version
 * sensitive). Instead this grader:
 *
 *   1. Extracts the model patch from the finished workdir (`git diff`),
 *      excluding any edits to the held-out test files.
 *   2. Writes a conformant per-instance prediction so the run can be graded by
 *      the official harness (`--predictions_path`).
 *   3. If an inline grader is supplied (Docker available), runs it and returns a
 *      real pass/fail verdict; otherwise marks the row "exported, ungraded"
 *      (graded:false) so it is excluded from pass@1 rather than counted as a
 *      failure.
 */
export async function gradeSwebench(opts: {
  workdir: string;
  task: BenchTask;
  cell: ModelCell;
  timeoutMs: number;
  /** Where per-instance prediction files are written. */
  predictionsDir: string;
  exec?: Exec | undefined;
  externalGrade?: SwebenchExternalGrade | undefined;
}): Promise<GradeResult> {
  const meta = opts.task.meta as unknown as SwebenchMeta;

  const patch = await extractModelPatch({
    workdir: opts.workdir,
    testPatch: meta.testPatch,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
  });

  await writeInstancePrediction(opts.predictionsDir, opts.cell.label, {
    instance_id: meta.instanceId,
    model_name_or_path: opts.cell.label,
    model_patch: patch,
  });

  // An empty patch resolves nothing — that is a genuine, gradeable failure.
  if (patch.trim().length === 0) {
    return { passed: false, graded: true, detail: 'empty patch (agent made no edits)' };
  }

  if (opts.externalGrade) {
    const verdict = await opts.externalGrade({
      instanceId: meta.instanceId,
      patch,
      image: meta.image,
      failToPass: meta.failToPass,
      passToPass: meta.passToPass,
      testPatch: meta.testPatch,
      workdir: opts.workdir,
      timeoutMs: opts.timeoutMs,
    });
    if (verdict !== undefined) {
      return { passed: verdict, graded: true };
    }
  }

  // No inline grading available — the patch is exported for the official harness.
  return {
    passed: false,
    graded: false,
    detail: `patch exported (${patch.length} bytes) — grade with the official SWE-bench harness`,
  };
}
