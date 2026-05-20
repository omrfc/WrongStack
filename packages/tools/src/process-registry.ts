/**
 * ProcessRegistry — global singleton that tracks all spawned child processes
 * from `bash` and `exec` tools. Enables:
 *
 *   - Listing active processes (for TUI status bar)
 *   - Killing individual processes or all processes (for Ctrl+C and /kill)
 *   - Detecting runaway processes (hung, looping)
 *   - Circuit breaker integration to prevent recursive/repeated failures
 *
 * Thread-safety: Node.js is single-threaded, but async callbacks can fire
 * in any order. All mutations go through synchronized Map methods.
 */
import type { ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import { CircuitBreaker, type CircuitBreakerSnapshot, type CircuitBreakerConfig } from './circuit-breaker.js';

export { type CircuitBreakerSnapshot, type CircuitBreakerConfig } from './circuit-breaker.js';

export interface TrackedProcess {
  pid: number;
  name: string;
  command: string;
  startedAt: number;
  sessionId?: string;
  /** The raw ChildProcess handle. Never call .kill() directly on this —
   *  use `kill()` below which handles process groups correctly on POSIX
   *  and degrades gracefully on Windows. */
  child: ChildProcess;
  /** True once the process has been kill()ed but not yet exited.
   *  We keep it in the registry until 'close' fires so callers can
   *  distinguish "still running" from "just exited". */
  killed: boolean;
}

interface KillOpts {
  /** SIGKILL instead of SIGTERM. Default: false (SIGTERM first). */
  force?: boolean;
  /** MS to wait between SIGTERM and SIGKILL on POSIX. Default: 2000. */
  graceMs?: number;
}

export interface RegistryStats {
  activeCount: number;
  totalCount: number;
  breaker: CircuitBreakerSnapshot;
}

const DEFAULT_GRACE_MS = 2000;

class ProcessRegistryImpl {
  private readonly processes = new Map<number, TrackedProcess>();
  private readonly breaker: CircuitBreaker;

  constructor(breakerConfig?: CircuitBreakerConfig) {
    this.breaker = new CircuitBreaker(breakerConfig);
  }

  register(info: Omit<TrackedProcess, 'killed'>): void {
    this.processes.set(info.pid, { ...info, killed: false });
  }

  /** Unregister a process by PID. Called on 'close' / 'exit' events. */
  unregister(pid: number): void {
    this.processes.delete(pid);
  }

  /** Get a single process by PID. */
  get(pid: number): TrackedProcess | undefined {
    return this.processes.get(pid);
  }

  /** Get all tracked processes. */
  list(): TrackedProcess[] {
    return Array.from(this.processes.values());
  }

  /** Get processes filtered by name (e.g. 'bash', 'exec'). */
  byName(name: string): TrackedProcess[] {
    return this.list().filter((p) => p.name === name);
  }

  /** Get processes filtered by session. */
  bySession(sessionId: string): TrackedProcess[] {
    return this.list().filter((p) => p.sessionId === sessionId);
  }

  /** Count of active (non-killed) processes. */
  get activeCount(): number {
    let n = 0;
    for (const p of this.processes.values()) {
      if (!p.killed) n++;
    }
    return n;
  }

  /**
   * Combined stats for observability — used by /ps and the TUI status bar.
   */
  stats(): RegistryStats {
    return {
      activeCount: this.activeCount,
      totalCount: this.processes.size,
      breaker: this.breaker.snapshot(),
    };
  }

  /**
   * Returns true if the circuit allows a new bash/exec call to proceed.
   * When false, callers MUST NOT spawn a process.
   */
  get canProceed(): boolean {
    return this.breaker.canProceed;
  }

  /**
   * Called before spawning a process. Returns true if allowed; false if
   * the circuit breaker is open.
   */
  beforeCall(): boolean {
    return this.breaker.beforeCall();
  }

  /**
   * Called after a process finishes. `durationMs` is wall-clock time;
   * `failed` is true for non-zero exit codes.
   */
  afterCall(durationMs: number, failed: boolean): void {
    this.breaker.afterCall(durationMs, failed);
  }

  /** Force-open the circuit breaker (Ctrl+C, /kill force). */
  forceBreakerOpen(): void {
    this.breaker.forceOpen();
  }

  /** Force-reset the circuit breaker to closed (/kill reset). */
  forceBreakerReset(): void {
    this.breaker.forceReset();
  }

  /** Kill a single process by PID.
   *
   *  On POSIX: sends SIGTERM to the *process group* (-pid) so that
   *  runaway grandchild processes (`sleep 9999 & disown`) are also killed.
   *  After `graceMs` a SIGKILL is sent if the process hasn't exited.
   *
   *  On Windows: `child.kill()` maps to TerminateProcess — process groups
   *  are not meaningfully supported. A second `force=true` call sends
   *  SIGKILL (which maps to TerminateProcess again — the distinction is
   *  in the exit code, not the signal).
   *
   *  Returns true if the process was found and kill was attempted.
   */
  kill(pid: number, opts: KillOpts = {}): boolean {
    const p = this.processes.get(pid);
    if (!p) return false;
    if (p.killed) return true; // already kill()ed, don't double-send

    const { force = false, graceMs = DEFAULT_GRACE_MS } = opts;
    const isWin = os.platform() === 'win32';

    if (isWin) {
      // Windows: no process group semantics; just kill the process.
      try {
        p.child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // Process may have already exited.
      }
      p.killed = true;
      return true;
    }

    // POSIX: kill the process group so grandchildren are cleaned up too.
    try {
      if (force) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          p.child.kill('SIGKILL');
        }
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          p.child.kill('SIGTERM');
        }
        // Schedule SIGKILL as backup.
        const timer = setTimeout(() => {
          // Re-check: process may have exited on its own.
          if (this.processes.has(pid) && !p.child.killed) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              try {
                p.child.kill('SIGKILL');
              } catch {
                /* already gone */
              }
            }
          }
        }, graceMs);
        timer.unref?.(); // Don't keep event loop alive.
      }
    } catch {
      // Process may have already exited.
    }
    p.killed = true;
    return true;
  }

  /**
   * Kill all tracked processes.
   * Returns the PIDs that were kill()ed.
   */
  killAll(opts: KillOpts = {}): number[] {
    const pids = Array.from(this.processes.keys());
    const killed: number[] = [];
    for (const pid of pids) {
      if (this.kill(pid, opts)) killed.push(pid);
    }
    return killed;
  }

  /**
   * Kill all processes for a specific session.
   * Returns the PIDs that were kill()ed.
   */
  killSession(sessionId: string, opts: KillOpts = {}): number[] {
    const pids = this.bySession(sessionId).map((p) => p.pid);
    const killed: number[] = [];
    for (const pid of pids) {
      if (this.kill(pid, opts)) killed.push(pid);
    }
    return killed;
  }
}

/** Module-level singleton. Initialized on first access. */
let _registry: ProcessRegistryImpl | undefined;

export function getProcessRegistry(): ProcessRegistryImpl {
  if (!_registry) {
    _registry = new ProcessRegistryImpl();
  }
  return _registry;
}

/** Reset for tests. */
export function _resetProcessRegistry(): void {
  _registry = undefined;
}

// ── Convenience re-exports ────────────────────────────────────────────────────

export type { KillOpts };