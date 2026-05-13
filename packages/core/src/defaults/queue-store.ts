import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
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

  constructor(opts: { dir: string }) {
    this.file = path.join(opts.dir, 'queue.json');
  }

  async write(items: PersistedQueueItem[]): Promise<void> {
    if (items.length === 0) {
      // Empty queue → remove the file rather than write `[]`. Keeps
      // a clean idle state on disk and makes `read()` cheaper.
      await this.clear();
      return;
    }
    await atomicWrite(this.file, JSON.stringify(items), { mode: 0o600 });
  }

  async read(): Promise<PersistedQueueItem[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: PersistedQueueItem[] = [];
    for (const v of parsed) {
      if (isPersistedQueueItem(v)) out.push(v);
    }
    return out;
  }

  async clear(): Promise<void> {
    try {
      await fsp.unlink(this.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      // Best-effort: a permission/lock error during clear is rare and
      // the queue slash command is non-critical. Warn so it's observable
      // but don't throw so the slash command doesn't crash.
      console.warn(`QueueStore.clear() failed for ${this.file}: ${(err as Error).message}`);
    }
  }
}

function isPersistedQueueItem(v: unknown): v is PersistedQueueItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['displayText'] === 'string' && Array.isArray(o['blocks']);
}
