import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '@wrongstack/core';
import { wstackGlobalRoot } from '@wrongstack/core/utils';

/**
 * Cross-process single-poller lock for a Telegram bot token.
 *
 * Telegram allows exactly one `getUpdates` consumer per token; two wstack
 * instances (TUI + WebUI, or two projects) polling the same token fight each
 * other and every cycle returns HTTP 409. This lock elects one poller: the
 * holder writes a heartbeat to a lock file under `~/.wrongstack/telegram/`,
 * other instances stand by and take over when the heartbeat goes stale or
 * the file disappears.
 */

interface LockFilePayload {
  /** Unique per PollLock instance — `pid` alone can't distinguish two locks in one process. */
  id: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface PollLockOptions {
  log?: Logger | undefined;
  /** How often the holder refreshes its heartbeat. Default: 15s. */
  heartbeatMs?: number | undefined;
  /** A lock whose heartbeat is older than this is considered stale. Default: 45s. */
  staleMs?: number | undefined;
}

/** Lock file path for a bot token. The token itself never appears in the path. */
export function lockPathForToken(token: string, globalRoot = wstackGlobalRoot()): string {
  const hash = createHash('sha256').update(token).digest('hex').slice(0, 12);
  return join(globalRoot, 'telegram', `poll-${hash}.lock`);
}

export class PollLock {
  private readonly id = `${process.pid}:${randomUUID()}`;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly log?: Logger | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _held = false;

  /** Invoked when the lock is stolen by another instance while held. */
  onLost?: (() => void) | undefined;

  constructor(
    readonly lockPath: string,
    opts?: PollLockOptions,
  ) {
    this.heartbeatMs = opts?.heartbeatMs ?? 15_000;
    this.staleMs = opts?.staleMs ?? 45_000;
    this.log = opts?.log;
  }

  get held(): boolean {
    return this._held;
  }

  /**
   * Try to acquire the lock. Returns true when this instance is now (or was
   * already) the holder. Safe to call repeatedly from a standby retry loop.
   */
  tryAcquire(): boolean {
    if (this._held) return true;

    const existing = this.readLock();
    if (existing && !this.isStale(existing)) return false;

    try {
      mkdirSync(dirname(this.lockPath), { recursive: true });
      // Remove any stale or corrupt file first, then create exclusively: when
      // two standby instances race for a stale lock, `wx` makes exactly one win.
      try {
        unlinkSync(this.lockPath);
      } catch {
        // Nothing to remove, or a competing instance already removed it.
      }
      const now = Date.now();
      const payload: LockFilePayload = {
        id: this.id,
        pid: process.pid,
        acquiredAt: now,
        heartbeatAt: now,
      };
      writeFileSync(this.lockPath, JSON.stringify(payload), { flag: 'wx' });
    } catch {
      return false; // Lost the race or the directory is unwritable.
    }

    this._held = true;
    this.startHeartbeat();
    return true;
  }

  /** Release the lock and stop the heartbeat. Idempotent. */
  release(): void {
    this.stopHeartbeat();
    if (!this._held) return;
    this._held = false;
    try {
      if (this.readLock()?.id === this.id) unlinkSync(this.lockPath);
    } catch {
      // Best effort — a stale file is reclaimed via the staleness check anyway.
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private heartbeatTick(): void {
    const current = this.readLock();
    if (!current || current.id !== this.id) {
      // Another instance stole the lock (e.g. this process was suspended past
      // the staleness window). Stop claiming it and notify the owner.
      this._held = false;
      this.stopHeartbeat();
      this.log?.warn('Telegram: poll lock was taken over by another instance.');
      this.onLost?.();
      return;
    }
    try {
      const payload: LockFilePayload = { ...current, heartbeatAt: Date.now() };
      // Write via temp + rename so a reader never sees a half-written file.
      const tmp = `${this.lockPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.lockPath);
    } catch (err) {
      this.log?.debug(`Telegram: poll lock heartbeat write failed: ${err}`);
    }
  }

  private readLock(): LockFilePayload | null {
    try {
      const raw = readFileSync(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as LockFilePayload;
      if (typeof parsed.id !== 'string' || typeof parsed.pid !== 'number') return null;
      return parsed;
    } catch {
      return null; // Missing or corrupt — treated as stale/absent.
    }
  }

  private isStale(payload: LockFilePayload): boolean {
    if (Date.now() - payload.heartbeatAt > this.staleMs) return true;
    return !this.isPidAlive(payload.pid);
  }

  private isPidAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but belongs to another user.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
