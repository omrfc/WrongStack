/**
 * spawn-background — platform-independent background process spawning.
 *
 * Provides truly fire-and-forget background process execution that:
 *   - Works consistently on Windows and POSIX
 *   - Does not block the parent Node.js event loop
 *   - Creates a fully independent child process (new process group/session)
 *   - Does NOT register with the ProcessRegistry (fire-and-forget)
 *   - Does NOT affect the circuit breaker
 *
 * POSIX: Uses setsid() to create a new session, fully detaching from the
 *        parent's process group. The child becomes a daemon-like process.
 *
 * Windows: Uses CREATE_NEW_PROCESS_GROUP flag with detached: true. The child
 *          runs in a new process group and won't be affected by Ctrl+C in
 *          the parent terminal.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import * as os from 'node:os';

export interface SpawnBackgroundOptions {
  /** Command to run */
  command: string;
  /** Arguments (for exec-style commands) */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Shell to use (default: system default) */
  shell?: string;
}

/**
 * Spawn a fully detached background process.
 *
 * @returns The spawned ChildProcess (already unref'd so it doesn't block exit)
 */
export function spawnBackground(opts: SpawnBackgroundOptions): {
  pid: number | null;
  child: ReturnType<typeof spawn>;
} {
  const isWin = os.platform() === 'win32';

  // Determine shell and args
  const shell = opts.shell ?? (isWin ? process.env['COMSPEC'] ?? 'cmd.exe' : '/bin/bash');
  const shellArgs = isWin ? ['/c', opts.command] : ['-c', opts.command];

  // Platform-specific spawn options for maximum detachment
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // POSIX: causes setsid() to be called; Windows: CREATE_NEW_PROCESS_GROUP
    // On Windows, windowsHide: true hides the console window
    windowsHide: isWin,
  };

  // On POSIX, the shell itself is spawned as the detached process leader.
  // The actual command runs as a child of that shell. This is fine for
  // fire-and-forget execution.
  const child = spawn(shell, shellArgs, spawnOpts);

  // Unref immediately so the parent can exit even if the child is still running
  child.unref();

  return {
    pid: child.pid ?? null,
    child,
  };
}

/**
 * Spawn a command (exec-style, no shell) as a detached background process.
 * This is more secure than shell spawning since there are no shell injection risks.
 *
 * @returns The spawned ChildProcess (already unref'd so it doesn't block exit)
 */
export function spawnBackgroundExec(
  command: string,
  args: string[] = [],
  cwd?: string,
  env?: Record<string, string>,
): {
  pid: number | null;
  child: ReturnType<typeof spawn>;
} {
  const isWin = os.platform() === 'win32';

  // Resolve .cmd/.bat on Windows - these require shell: true
  const isBatchFile = isWin && (command.endsWith('.cmd') || command.endsWith('.bat'));

  const spawnOpts: SpawnOptions = {
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: isWin,
    ...(isBatchFile ? { shell: true } : {}),
  };

  const child = spawn(command, args, spawnOpts);

  // Unref immediately so the parent can exit even if the child is still running
  child.unref();

  return {
    pid: child.pid ?? null,
    child,
  };
}

// Re-export types
export type { ChildProcess } from 'node:child_process';
