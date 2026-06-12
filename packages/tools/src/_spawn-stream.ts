import { spawn } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core';
import type { ToolProgressEvent } from '@wrongstack/core';
import { resolveWin32Command } from './_win32-resolve.js';
export interface SpawnStreamResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  error?: string | undefined;
}

export interface SpawnStreamOptions {
  cmd: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  maxBytes?: number | undefined;
  /** Bytes of new stdout/stderr to accumulate before yielding a `partial_output` event. */
  flushBytes?: number | undefined;
  /** Maximum chunks to buffer before applying backpressure to the child. Default 500. */
  maxQueueSize?: number | undefined;
}

/**
 * Spawn a child process and yield `partial_output` progress events as
 * stdout/stderr arrive (batched by byte threshold), then return the full
 * buffered result. Shared between install/lint/format/typecheck/test/audit
 * so the TUI live tail sees consistent progress regardless of which tool
 * is running.
 */
export async function* spawnStream(
  opts: SpawnStreamOptions,
): AsyncGenerator<ToolProgressEvent, SpawnStreamResult> {
  const max = opts.maxBytes ?? 200_000;
  const flushAt = opts.flushBytes ?? 4 * 1024;
  const maxQueue = opts.maxQueueSize ?? 500;
  let stdout = '';
  let stderr = '';
  let pending = '';
  let error: string | undefined;

  const cmd = resolveWin32Command(opts.cmd);
  const needsShell = process.platform === 'win32' && (cmd.endsWith('.cmd') || cmd.endsWith('.bat'));

  const child = spawn(cmd, opts.args, {
    cwd: opts.cwd,
    signal: opts.signal,
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(needsShell ? { shell: true, windowsVerbatimArguments: true } : {}),
  });

  type Chunk = { kind: 'out' | 'err' | 'close' | 'error'; data: string; code?: number | undefined };
  const queue: Chunk[] = [];
  let waiter: (() => void) | undefined;
  let paused = false;
  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  };

  // Resume the stream when there's room in the queue
  const resume = () => {
    if (paused && queue.length < maxQueue) {
      paused = false;
      child.stdout?.resume();
      child.stderr?.resume();
    }
  };

  // Note: chunks may still arrive briefly after pause() (already in flight) —
  // they are accumulated and queued rather than dropped, so the queue can
  // overshoot maxQueue by a few entries but no output is silently lost.
  child.stdout?.on('data', (c) => {
    const s = c.toString();
    if (stdout.length < max) stdout += s;
    queue.push({ kind: 'out', data: s });
    wake();
    // Apply backpressure if queue is growing faster than we consume
    if (!paused && queue.length >= maxQueue) {
      paused = true;
      child.stdout?.pause();
      child.stderr?.pause();
    }
  });
  child.stderr?.on('data', (c) => {
    const s = c.toString();
    if (stderr.length < max) stderr += s;
    queue.push({ kind: 'err', data: s });
    wake();
    if (!paused && queue.length >= maxQueue) {
      paused = true;
      child.stdout?.pause();
      child.stderr?.pause();
    }
  });
  child.on('error', (e) => {
    error = e.message;
    queue.push({ kind: 'error', data: e.message });
    wake();
  });
  child.on('close', (code) => {
    queue.push({ kind: 'close', data: '', code: code ?? 0 });
    wake();
  });

  let exitCode = 0;
  let spawnFailed = false;
  for (;;) {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
    const chunk = queue.shift()!;
    // Resume reading after consuming a chunk
    resume();
    if (chunk.kind === 'close') {
      // If we already saw a spawn error (ENOENT etc.), keep exitCode=1
      // rather than the negative platform code Node fabricates.
      if (!spawnFailed) exitCode = chunk.code ?? 0;
      break;
    }
    if (chunk.kind === 'error') {
      spawnFailed = true;
      exitCode = 1;
      // close usually follows
      continue;
    }
    pending += chunk.data;
    if (pending.length >= flushAt) {
      yield { type: 'partial_output', text: pending };
      pending = '';
    }
  }
  if (pending.length > 0) {
    yield { type: 'partial_output', text: pending };
  }

  return {
    stdout,
    stderr,
    exitCode,
    truncated: stdout.length >= max || stderr.length >= max,
    error,
  };
}
