import { spawn } from 'node:child_process';
import * as os from 'node:os';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { stripAnsi } from '@wrongstack/core';
import { buildChildEnv } from './_env.js';
import { truncateMiddle } from './_util.js';

interface BashInput {
  command: string;
  timeout_ms?: number;
  background?: boolean;
}

interface BashOutput {
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  pid?: number;
}

const MAX_OUTPUT = 32_768;
const DEFAULT_TIMEOUT = 30_000;
// Flush partial_output every 200ms or when 4 KiB accumulates — whichever
// comes first. Smaller batches make the TUI feel responsive; larger ones
// keep EventBus traffic reasonable on chatty processes.
const STREAM_FLUSH_INTERVAL_MS = 200;
const STREAM_FLUSH_BYTES = 4 * 1024;

export const bashTool: Tool<BashInput, BashOutput> = {
  name: 'bash',
  category: 'Shell',
  description: 'Run a shell command. stdout and stderr are merged.',
  usageHint:
    'Runs via `bash -c` (or `cmd /c` on Windows). Cwd is the project root. Default timeout 30s. Output truncated from the middle if oversized. Use for git, npm, builds, tests.',
  permission: 'confirm',
  mutating: true,
  // Trust rules match on the literal `command` string. Without subjectKey
  // the policy heuristic would have done the same here, but declaring it
  // explicitly removes the implicit cross-tool aliasing.
  subjectKey: 'command',
  timeoutMs: 30_000,
  maxOutputBytes: MAX_OUTPUT,
  estimatedDurationMs: 3_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'integer' },
      background: { type: 'boolean' },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    let final: BashOutput | undefined;
    for await (const ev of bashTool.executeStream!(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('bash: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<BashOutput>> {
    if (!input?.command) throw new Error('bash: command is required');
    const timeoutMs = Math.max(1, Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT, 600_000));

    const isWin = os.platform() === 'win32';
    const shell = isWin
      ? (process.env['COMSPEC'] ?? 'cmd.exe')
      : (process.env['SHELL'] ?? '/bin/bash');
    const args = isWin ? ['/c', input.command] : ['-c', input.command];

    const env = buildChildEnv(ctx.session?.id);

    // On POSIX we put the shell in its own process group so that timeout /
    // abort can kill the entire group with `process.kill(-pid)`. Otherwise
    // `bash -c "sleep 9999 & disown"` would leave the grandchild running.
    // `detached: true` is also reused for the user-facing background mode;
    // we always want detached on POSIX, only on Windows is it tied to the
    // explicit background flag.
    const detached = isWin ? !!input.background : true;
    const child = spawn(shell, args, {
      cwd: ctx.projectRoot,
      env,
      stdio: input.background ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      detached,
      signal: opts.signal,
    });

    if (input.background) {
      const pid = child.pid;
      if (typeof pid === 'number') child.unref();
      yield {
        type: 'final',
        output: {
          output: `[background] pid=${pid ?? 'unknown'}`,
          exit_code: null,
          timed_out: false,
          pid,
        },
      };
      return;
    }

    let buf = '';
    let pending = '';
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      if (isWin) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      } else {
        try {
          // Kill the process group, not just the shell — pid is positive,
          // group id is the negated pid. Without this a runaway grandchild
          // ('sleep 9999 & disown') survives bash termination.
          if (typeof child.pid === 'number') {
            try {
              process.kill(-child.pid, 'SIGTERM');
            } catch {
              child.kill('SIGTERM');
            }
          } else {
            child.kill('SIGTERM');
          }
          const killTimer = setTimeout(() => {
            try {
              if (typeof child.pid === 'number') {
                try {
                  process.kill(-child.pid, 'SIGKILL');
                } catch {
                  child.kill('SIGKILL');
                }
              } else {
                child.kill('SIGKILL');
              }
            } catch {
              /* ignore */
            }
          }, 2000);
          timers.push(killTimer);
          killTimer.unref?.(); // Don't keep event loop alive on clean exit
        } catch {
          /* ignore */
        }
      }
    }, timeoutMs);
    timers.push(timer);
    timer.unref?.();

    // Bridge the EventEmitter-style child to an async iterator. We push
    // chunks into a queue and let the generator pull them; this lets us
    // yield 'partial_output' events to the executor at flush boundaries.
    type Chunk =
      | { kind: 'data'; text: string }
      | { kind: 'end'; code: number | null }
      | { kind: 'error'; err: Error };
    const queue: Chunk[] = [];
    let resolveNext: ((c: Chunk) => void) | null = null;
    const push = (c: Chunk) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(c);
      } else {
        queue.push(c);
      }
    };
    const next = (): Promise<Chunk> =>
      new Promise((resolve) => {
        const c = queue.shift();
        if (c) resolve(c);
        else resolveNext = resolve;
      });

    let lastFlush = Date.now();
    const flush = () => {
      if (pending.length === 0) return null;
      const text = pending;
      pending = '';
      lastFlush = Date.now();
      return text;
    };

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      buf += text;
      pending += text;
      push({ kind: 'data', text });
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      buf += text;
      pending += text;
      push({ kind: 'data', text });
    });
    child.on('error', (err) => {
      for (const t of timers) clearTimeout(t);
      push({ kind: 'error', err });
    });
    child.on('close', (code) => {
      for (const t of timers) clearTimeout(t);
      push({ kind: 'end', code });
    });

    try {
      while (true) {
        const c = await next();
        if (c.kind === 'error') throw c.err;
        if (c.kind === 'end') {
          const remainder = flush();
          if (remainder !== null) {
            yield { type: 'partial_output', text: remainder };
          }
          const cleaned = stripAnsi(buf).replace(/\r\n?/g, '\n');
          yield {
            type: 'final',
            output: {
              output: truncateMiddle(cleaned, MAX_OUTPUT),
              exit_code: c.code,
              timed_out: timedOut,
            },
          };
          return;
        }
        // Decide whether to flush. Time-based OR size-based to keep latency
        // low for slow-emitting commands without overwhelming the TUI for
        // chatty ones.
        const now = Date.now();
        if (pending.length >= STREAM_FLUSH_BYTES || now - lastFlush >= STREAM_FLUSH_INTERVAL_MS) {
          const text = flush();
          if (text) yield { type: 'partial_output', text };
        }
      }
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  },
};

// Re-export types so consumers can narrow on stream events.
export type { BashInput, BashOutput };
