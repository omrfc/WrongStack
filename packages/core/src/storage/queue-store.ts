import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import type { ContentBlock } from '../types/blocks.js';
import { atomicWrite } from '../utils/atomic-write.js';

/**
 * The persisted form of a single queued user message. The TUI's
 * in-memory QueueItem has a render id; that's pure UI bookkeeping, so
 * we drop it when serializing — fresh ids are assigned on rehydrate.
 */
export interface PersistedQueueItem {
  displayText: string;
  blocks: ContentBlock[];
}

/**
 * Side-file storage for a session's pending input queue. Lives at
 * `<sessionDir>/queue.json` next to the attachment spool. Reads are
 * tolerant (missing/malformed file → empty array); writes are atomic
 * (tmp + rename) so a crash mid-write can never leave a partial file
 * the next launch would choke on.
 *
 * The contract is "snapshot replacement": every mutation hands the
 * full queue and we rewrite the file. The queue is small (rarely more
 * than a handful of messages), so this is cheaper than delta logging
 * and avoids the replay complexity.
 */
export class QueueStore {
  private readonly file: string;
  // Use `| undefined` (not `?`) so exactOptionalPropertyTypes doesn't
  // reject assigning an optional constructor parameter to these fields.
  private readonly events: EventBus | undefined;
  private readonly traceId: string | undefined;

  constructor(opts: { dir: string; events?: EventBus; traceId?: string }) {
    this.file = path.join(opts.dir, 'queue.json');
    this.events = opts.events;
    this.traceId = opts.traceId;
  }

  async write(items: PersistedQueueItem[]): Promise<void> {
    const t0 = Date.now();
    if (items.length === 0) {
      // Empty queue → remove the file rather than write `[]`. Keeps
      // a clean idle state on disk and makes `read()` cheaper.
      await this.clear();
      return;
    }
    try {
      await atomicWrite(this.file, JSON.stringify(items), { mode: 0o600 });
      this.events?.emit('storage.write', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'write',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'write',
        error: err instanceof Error ? err.message : String(err),
        recoverable: false,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'queue_store.write_failed',
        path: this.file,
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }

  async read(): Promise<PersistedQueueItem[]> {
    const t0 = Date.now();
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.events?.emit('storage.read', {
          sessionId: this.traceId ?? '~boot~',
          store: 'queue',
          filePath: this.file,
          operation: 'read',
          outcome: 'success',
          durationMs: Date.now() - t0,
          ...(this.traceId !== undefined && { traceId: this.traceId }),
        });
        return [];
      }
      this.events?.emit('storage.error', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'read',
        error: err instanceof Error ? err.message : String(err),
        recoverable: true,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'queue_store.read_failed',
        path: this.file,
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.events?.emit('storage.read', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'read',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'parse_failed',
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      return [];
    }
    if (!Array.isArray(parsed)) {
      this.events?.emit('storage.read', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'read',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'invalid_schema',
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      return [];
    }
    this.events?.emit('storage.read', {
      sessionId: this.traceId ?? '~boot~',
      store: 'queue',
      filePath: this.file,
      operation: 'read',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(this.traceId !== undefined && { traceId: this.traceId }),
    });
    const out: PersistedQueueItem[] = [];
    for (const v of parsed) {
      if (isPersistedQueueItem(v)) out.push(v);
    }
    return out;
  }

  async clear(): Promise<void> {
    const t0 = Date.now();
    try {
      await fsp.unlink(this.file);
      this.events?.emit('storage.write', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'clear',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      this.events?.emit('storage.error', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'clear',
        error: err instanceof Error ? err.message : String(err),
        recoverable: true,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      // Best-effort: a permission/lock error during clear is rare and
      // the queue slash command is non-critical. Warn so it's observable
      // but don't throw so the slash command doesn't crash.
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'queue_store.clear_failed',
        path: this.file,
        message: (err as Error).message,
        timestamp: new Date().toISOString(),
      }));
    }
  }
}

function isPersistedQueueItem(v: unknown): v is PersistedQueueItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['displayText'] === 'string' && Array.isArray(o['blocks']);
}
