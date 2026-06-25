// makeCommandVerifier — the shared completion-gate verifier for an SDD parallel
// run. Both surfaces that start a run (the CLI `/sdd parallel` handler and the
// standalone WebUI wizard) need an identical `verifyTask`: when a task declares
// `metadata.verificationCommand`, run it in the task's worktree cwd and only let
// the task complete on exit 0. No command → no-op. Bounded by a timeout so a
// hung verifier can't wedge the run.
//
// core may use node:child_process directly — it already does for git detection.

import { spawn } from 'node:child_process';
import type { TaskNode } from '../types/task-graph.js';
import type { TaskResult } from '../types/multi-agent.js';

export interface CommandVerifierOptions {
  /** Metadata key holding the shell command to run. Default 'verificationCommand'. */
  metadataKey?: string;
  /** Kill + fail the verification after this many ms. Default 180_000 (3 min). */
  timeoutMs?: number;
}

/**
 * Build a `verifyTask` closure (shape matches {@link SddParallelRunOptions.verifyTask}).
 * Returns `{ ok: true }` immediately when the task carries no verification command,
 * otherwise spawns the command in `cwd` (shell, output discarded) and resolves
 * `{ ok: false, reason }` on non-zero exit, spawn error, or timeout.
 */
export function makeCommandVerifier(options: CommandVerifierOptions = {}) {
  const metadataKey = options.metadataKey ?? 'verificationCommand';
  const timeoutMs = options.timeoutMs ?? 180_000;

  return async function verifyTask(info: {
    task: TaskNode;
    result: TaskResult;
    cwd: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const cmd = info.task.metadata?.[metadataKey];
    if (typeof cmd !== 'string' || !cmd.trim()) return { ok: true };

    return await new Promise((resolve) => {
      const child = spawn(cmd, { cwd: info.cwd, shell: true, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, reason: `verification timed out: ${cmd}` });
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(
          code === 0 ? { ok: true } : { ok: false, reason: `verification failed (exit ${code}): ${cmd}` },
        );
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `verification spawn error: ${String(err)}` });
      });
    });
  };
}
