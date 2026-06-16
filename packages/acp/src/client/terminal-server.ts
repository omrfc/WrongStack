/**
 * TerminalServer — answers `terminal/*` methods from an ACP agent.
 *
 * The spec lets agents spawn shell commands inside the client's
 * environment and observe their output. We honour the protocol, but
 * every command runs under a per-process timeout and a byte limit on
 * retained output, both to keep runaway agents from filling memory
 * and to give the runner a clean signal when something is stuck.
 *
 * Scoping: commands run with `cwd` set to the agent's requested cwd
 * if it's inside `projectRoot`, else `projectRoot`. There is no
 * per-terminal `env` allowlist in v1; the agent's env is propagated
 * from the spawn options.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';

export interface TerminalServerOptions {
  projectRoot: string;
  /** Hard cap on per-command wall-clock. Default 5 minutes. */
  commandTimeoutMs?: number;
  /** Bytes of output to retain per terminal. Default 1 MiB. */
  outputByteLimit?: number;
  /** Optional abort signal that kills ALL active terminals. */
  signal?: AbortSignal;
}

interface TerminalState {
  proc: ReturnType<typeof spawn>;
  cwd: string;
  command: string;
  args: string[];
  /** Output buffer as a string; appended as bytes arrive. */
  output: string;
  /** Bytes currently retained (post-truncation). */
  retainedBytes: number;
  /** True once we've dropped output to fit under the per-call byte limit. */
  truncated: boolean;
  exitStatus?: { exitCode: number | null; signal: string | null } | undefined;
  /** Resolves when the process exits. */
  exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
  /** Per-terminal timeout handle. */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

export class TerminalServer {
  private readonly terminals = new Map<string, TerminalState>();
  private readonly projectRoot: string;
  private readonly commandTimeoutMs: number;
  private readonly outputByteLimit: number;
  private nextId = 1;

  constructor(opts: TerminalServerOptions) {
    this.projectRoot = path.resolve(opts.projectRoot);
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 5 * 60_000;
    this.outputByteLimit = opts.outputByteLimit ?? 1024 * 1024;
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.releaseAll());
    }
  }

  /** Spawn a new terminal. Returns the agent-facing id. */
  create(params: {
    sessionId: string;
    command: string;
    args?: string[];
    env?: { name: string; value: string }[];
    cwd?: string;
    outputByteLimit?: number;
  }): { terminalId: string } {
    const id = `term_${this.nextId++}`;
    const cwd = this.resolveCwd(params.cwd);
    const proc = spawn(params.command, params.args ?? [], {
      cwd,
      env: this.buildEnv(params.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // shell: false on purpose. The terminal server is invoked with
      // the agent's explicit argv; turning on shell-mode would make
      // the command a single shell-parsed string, which breaks
      // Windows cmd quoting for the common case of running node with
      // `-e "<script>"`. If a future feature needs shell features
      // (pipes, redirects), it should be opt-in per-call, not the
      // default.
    });

    const state: TerminalState = {
      proc,
      cwd,
      command: params.command,
      args: params.args ?? [],
      output: '',
      retainedBytes: 0,
      truncated: false,
      exitStatus: undefined,
      timeoutHandle: null,
      exitPromise: new Promise((resolve) => {
        proc.on('close', (code, signalName) => {
          if (state.timeoutHandle) {
            clearTimeout(state.timeoutHandle);
            state.timeoutHandle = null;
          }
          const exitStatus = {
            exitCode: typeof code === 'number' ? code : null,
            signal: typeof signalName === 'string' ? signalName : null,
          };
          state.exitStatus = exitStatus;
          resolve(exitStatus);
        });
        proc.on('error', (err) => {
          // Spawn-time errors (ENOENT etc.) — surface as a special
          // exit status with exitCode 127 (command not found).
          if (state.timeoutHandle) {
            clearTimeout(state.timeoutHandle);
            state.timeoutHandle = null;
          }
          const exitStatus = { exitCode: 127, signal: null };
          state.exitStatus = exitStatus;
          state.output += `[spawn error] ${err.message}\n`;
          state.retainedBytes += Buffer.byteLength(state.output, 'utf8');
          resolve(exitStatus);
        });
      }),
    };

    const perCallByteLimit = params.outputByteLimit ?? this.outputByteLimit;
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    const onData = (chunk: string): void => {
      state.output += chunk;
      state.retainedBytes = Buffer.byteLength(state.output, 'utf8');
      // Truncate from the start if we exceed the limit. Per spec, the
      // truncation MUST happen at a character boundary. UTF-8 slicing
      // a string can land mid-codepoint; we trim back to the last
      // complete code point to honour that.
      while (state.retainedBytes > perCallByteLimit) {
        const trimmed = state.output.slice(1);
        // Cheap boundary check: if dropping the first char doesn't
        // shrink us by at least one byte, we're slicing inside a
        // multi-byte sequence; keep dropping.
        state.output = trimmed;
        const newBytes = Buffer.byteLength(state.output, 'utf8');
        if (newBytes >= state.retainedBytes) {
          // give up — would loop forever
          break;
        }
        state.retainedBytes = newBytes;
        state.truncated = true;
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    state.timeoutHandle = setTimeout(() => {
      // Best-effort kill; we don't have an exact "TIMEOUT" stop reason
      // so we just exit with -1.
      try {
        proc.kill('SIGTERM');
      } catch {
        // already dead
      }
    }, this.commandTimeoutMs);

    this.terminals.set(id, state);
    return { terminalId: id };
  }

  /** Return captured output and (if available) the exit status. */
  output(terminalId: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`unknown terminal: ${terminalId}`);
    return {
      output: state.output,
      truncated: state.truncated,
      ...(state.exitStatus ? { exitStatus: state.exitStatus } : {}),
    };
  }

  /** Block until the process exits. Resolves with the exit status. */
  async waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`unknown terminal: ${terminalId}`);
    return state.exitPromise;
  }

  /** Kill the process but keep the terminal record (agent can still read output). */
  kill(terminalId: string): void {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`unknown terminal: ${terminalId}`);
    try {
      state.proc.kill('SIGTERM');
    } catch {
      // already dead
    }
  }

  /** Kill the process if alive and remove the record. */
  release(terminalId: string): void {
    const state = this.terminals.get(terminalId);
    if (!state) return;
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = null;
    }
    try {
      state.proc.kill('SIGKILL');
    } catch {
      // already dead
    }
    this.terminals.delete(terminalId);
  }

  /** Kill all active terminals. Used on session close. */
  releaseAll(): void {
    for (const id of [...this.terminals.keys()]) {
      this.release(id);
    }
  }

  private resolveCwd(cwd: string | undefined): string {
    if (!cwd) return this.projectRoot;
    const resolved = path.resolve(cwd);
    const rootWithSep = this.projectRoot.endsWith(path.sep)
      ? this.projectRoot
      : this.projectRoot + path.sep;
    if (resolved !== this.projectRoot && !resolved.startsWith(rootWithSep)) {
      return this.projectRoot;
    }
    return resolved;
  }

  private buildEnv(
    agentEnv?: { name: string; value: string }[],
  ): NodeJS.ProcessEnv {
    // On Windows, `process.env` stores PATH as `Path` (the OS-native
    // case). Node's child_process.spawn looks up `env.PATH` (uppercase)
    // when resolving the binary. A plain `{ ...process.env }` spread
    // preserves `Path` but not `PATH`, which causes ENOENT for any
    // binary resolved via $PATH on Windows. Copy uppercase aliases so
    // spawn can find the binary.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === 'win32') {
      if (env.Path !== undefined && env.PATH === undefined) env.PATH = env.Path;
      if (env.PATHEXT !== undefined && env.PATHEXT_CASE === undefined) {
        env.PATHEXT_CASE = env.PATHEXT;
      }
    }
    if (agentEnv) {
      for (const { name, value } of agentEnv) {
        env[name] = value;
      }
    }
    return env;
  }
}
