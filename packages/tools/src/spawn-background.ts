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
 * POSIX: Uses setsid() (detached: true) to create a new session, fully
 *        detaching from the parent's process group. The child becomes a
 *        daemon-like process.
 *
 * Windows: detached: false + windowsHide: true (CREATE_NO_WINDOW). This is
 *          deliberate: CreateProcess IGNORES CREATE_NO_WINDOW when combined
 *          with DETACHED_PROCESS (which detached: true sets), so a detached
 *          cmd.exe runs console-less and its console-app *grandchildren*
 *          (node, etc.) each allocate a fresh VISIBLE console window.
 *          CREATE_NO_WINDOW instead gives the child a hidden console that
 *          grandchildren inherit — no window ever appears. Windows children
 *          survive parent exit regardless of detached, and the hidden
 *          console also isolates them from the terminal's Ctrl+C, so
 *          nothing is lost by dropping DETACHED_PROCESS.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core';
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

  // Platform-specific spawn options for maximum detachment.
  // win32 must NOT set detached: DETACHED_PROCESS makes Windows ignore
  // CREATE_NO_WINDOW, and the console-less cmd.exe's grandchildren then pop
  // visible console windows (see module doc).
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd ?? process.cwd(),
    env: buildChildEnv({ extra: opts.env }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin, // POSIX: setsid()
    windowsHide: true,
  };

  // On POSIX, the shell itself is spawned as the detached process leader.
  // The actual command runs as a child of that shell. This is fine for
  // fire-and-forget execution.
  const child = spawn(shell, shellArgs, spawnOpts);

  // Fire-and-forget: an unhandled 'error' event (e.g. ENOENT) would crash the
  // host process. Callers can still attach their own listener on `child`.
  child.on('error', (err) => {
    // ENOENT / EACCES on the binary itself is expected for missing commands;
    // don't crash the parent — just log at debug level.
    console.log(JSON.stringify({ level: 'debug', event: 'spawn_error', cmd: opts.command, error: err.message }));
  });

  releaseStdio(child);

  // Unref immediately so the parent can exit even if the child is still running
  child.unref();

  return {
    pid: child.pid ?? null,
    child,
  };
}

/**
 * Drain and release a fire-and-forget child's stdio pipes. Nothing here ever
 * reads them: without resume() a chatty child blocks as soon as the OS pipe
 * buffer (~64 KB) fills, and the open pipe handles keep the parent's event
 * loop alive even after child.unref() — a one-shot CLI run could never exit
 * while a background dev server kept its pipes open. resume() switches the
 * streams to flowing mode and discards the data (callers that attach their
 * own 'data' listener still receive chunks); unref() detaches the handles
 * from the event loop.
 */
function releaseStdio(child: ReturnType<typeof spawn>): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.resume();
    (stream as never as { unref?: () => void }).unref?.();
  }
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

  // Same win32 rule as spawnBackground: detached + windowsHide conflict, and
  // the hidden console from CREATE_NO_WINDOW is what keeps any children of
  // the spawned command windowless.
  const spawnOpts: SpawnOptions = {
    cwd: cwd ?? process.cwd(),
    env: buildChildEnv({ extra: env }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin,
    windowsHide: true,
    ...(isBatchFile ? { shell: true } : {}),
  };

  const child = spawn(command, args, spawnOpts);

  // Fire-and-forget: an unhandled 'error' event (e.g. ENOENT) would crash the
  // host process. Callers can still attach their own listener on `child`.
  child.on('error', (err) => {
    // ENOENT / EACCES on the binary itself is expected for missing commands;
    // don't crash the parent — just log at debug level.
    console.log(JSON.stringify({ level: 'debug', event: 'spawn_error', cmd: command, error: err.message }));
  });

  releaseStdio(child);

  // Unref immediately so the parent can exit even if the child is still running
  child.unref();

  return {
    pid: child.pid ?? null,
    child,
  };
}

// Re-export types
export type { ChildProcess } from 'node:child_process';
