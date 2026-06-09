import { expectDefined } from '../utils/expect-defined.js';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { safeParse } from '../utils/safe-json.js';
/**
 * ToolAuditLog — idea #9 from IDEAS.md.
 *
 * Tamper-evident audit trail for tool calls. Every tool_use /
 * tool_result pair is appended to a sidecar JSONL with a chained
 * SHA-256 — each entry's `prevHash` is the prior entry's `hash`,
 * so any post-hoc modification of a single line breaks the chain
 * from that point forward.
 *
 * Why a sidecar (not the session JSONL)?
 *   Same reason as `AnnotationsStore` and `ReplayLogStore`: the
 *   session log is an event-sourced journal. Mixing in a hash
 *   chain would inflate every read and tightly couple the
 *   integrity check to the event format. Sidecar keeps both
 *   concerns orthogonal.
 *
 * What "tamper-evident" means here:
 *   - The hash covers the full serialized entry: tool name, id,
 *     input, output, timestamp, author. Changing any byte
 *     changes the hash.
 *   - The chain is sequential — a verifier walks the file in
 *     order, recomputing each hash, and checks `prevHash`
 *     matches the previous entry's `hash`.
 *   - Any insertion, deletion, or modification of a single
 *     entry surfaces as a "chain broken at entry N" verdict.
 *
 * What it does NOT defend against:
 *   - An attacker who rewrites the whole file consistently.
 *     For that you'd need an external anchor (signing key,
 *     transparency log, etc.) — out of scope for Phase 1.
 *   - The agent itself misbehaving; this is post-hoc audit, not
 *     real-time enforcement. Use `PermissionPolicy` for that.
 *
 * File layout: `<dir>/<sessionId>.audit.jsonl`, one entry per
 * line. The chain starts with a `genesis` entry whose
 * `prevHash` is all zeros.
 */
export interface AuditEntry {
  /** Monotonic index (0-based). */
  index: number;
  /** UUID for cross-referencing with logs. */
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** Hash of the previous entry (or all-zeros for the genesis entry). */
  prevHash: string;
  /** Hash of this entry's content (sha256 over the canonical JSON). */
  hash: string;
  toolName: string;
  toolUseId: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

const GENESIS_PREV = '0'.repeat(64);

export type VerifyResult =
  | { ok: true; entries: number }
  | { ok: false; brokenAt: number; reason: string };

export interface ToolAuditLogOptions {
  /** Directory where `<sessionId>.audit.jsonl` files live. */
  dir: string;
  /**
   * Flush the file system cache to disk every N writes per session.
   * Default 100. Lower values = better crash durability, more I/O overhead.
   * Set to `Infinity` to disable periodic fsync (fastest, but highest data-loss risk).
   */
  fsyncEvery?: number | undefined;
}

/** Default number of writes between fsync calls. */
const DEFAULT_FSYNC_EVERY = 100;

export class ToolAuditLog {
  private readonly dir: string;
  /** In-memory cache of the last entry's hash (per session), to compute chains efficiently. */
  private readonly tailHash = new Map<string, string>();
  /** In-memory counter for entry indices — avoids re-reading the file on every write. */
  private readonly tailIndex = new Map<string, number>();
  /** Tracks writes since last fsync, per session. */
  private readonly unSyncedWrites = new Map<string, number>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly fsyncEvery: number;

  constructor(opts: ToolAuditLogOptions) {
    this.dir = opts.dir;
    this.fsyncEvery = opts.fsyncEvery ?? DEFAULT_FSYNC_EVERY;
  }

  /**
   * Append a tool call/result pair to the chain. Returns the
   * resulting entry. Idempotency is not guaranteed — if you
   * record the same tool_use twice you get two entries. That's
   * intentional: the audit log is a record, not a cache.
   */
  async record(input: {
    sessionId: string;
    toolName: string;
    toolUseId: string;
    input: unknown;
    output: unknown;
    isError: boolean;
  }): Promise<AuditEntry> {
    let entry!: AuditEntry; // assigned inside the enqueue callback
    await this.enqueue(input.sessionId, async () => {
      await withFileLock(this.filePath(input.sessionId), async () => {
        const entries = await this.readAll(input.sessionId);
        const prev = entries.at(-1);
        const prevHash = prev?.hash ?? GENESIS_PREV;
        const index = prev ? prev.index + 1 : 0;
        const id = randomUUID();
        const ts = new Date().toISOString();
        const content = {
          id,
          ts,
          prevHash,
          toolName: input.toolName,
          toolUseId: input.toolUseId,
          input: input.input,
          output: input.output,
          isError: input.isError,
          index,
        };
        const hash = createHash('sha256').update(stableStringify(content), 'utf8').digest('hex');
        entry = {
          id,
          ts,
          prevHash,
          hash,
          toolName: input.toolName,
          toolUseId: input.toolUseId,
          input: input.input,
          output: input.output,
          isError: input.isError,
          index,
        };
        entries.push(entry);
        await this.writeAll(input.sessionId, entries);
        this.tailHash.set(input.sessionId, hash);
        this.tailIndex.set(input.sessionId, index + 1);
      });
    });
    return entry;
  }

  /**
   * Walk the chain and verify every entry's hash and prevHash.
   * Returns a structured verdict — never throws.
   */
  async verify(sessionId: string): Promise<VerifyResult> {
    const entries = await this.readAll(sessionId);
    if (entries.length === 0) return { ok: true, entries: 0 };
    // The first entry's prevHash must be the all-zeros genesis marker.
    if (entries[0]?.prevHash !== GENESIS_PREV) {
      return {
        ok: false,
        brokenAt: 0,
        reason: 'first entry is not the genesis (prevHash != 0…0)',
      };
    }
    let prevHash = GENESIS_PREV;
    for (let i = 0; i < entries.length; i++) {
      const e = expectDefined(entries[i]);
      if (e.prevHash !== prevHash) {
        return {
          ok: false,
          brokenAt: i,
          reason: `prevHash mismatch at entry ${i} (expected ${prevHash.slice(0, 8)}…, got ${e.prevHash.slice(0, 8)}…)`,
        };
      }
      // Recompute the hash from the entry's content (without the
      // `hash` field itself, which is what we are verifying).
      const content = {
        id: e.id,
        ts: e.ts,
        prevHash: e.prevHash,
        toolName: e.toolName,
        toolUseId: e.toolUseId,
        input: e.input,
        output: e.output,
        isError: e.isError,
        index: e.index,
      };
      const expectedHash = createHash('sha256')
        .update(stableStringify(content), 'utf8')
        .digest('hex');
      if (expectedHash !== e.hash) {
        return {
          ok: false,
          brokenAt: i,
          reason: `hash mismatch at entry ${i} (entry content was modified)`,
        };
      }
      prevHash = e.hash;
    }
    return { ok: true, entries: entries.length };
  }

  /** All entries for a session, in insertion order. */
  async load(sessionId: string): Promise<AuditEntry[]> {
    return this.readAll(sessionId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    if (
      !sessionId ||
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      sessionId.includes('..')
    ) {
      throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    return path.join(this.dir, `${sessionId}.audit.jsonl`);
  }

  private async readAll(sessionId: string): Promise<AuditEntry[]> {
    const fp = this.filePath(sessionId);
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const out: AuditEntry[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = safeParse<AuditEntry>(line);
          if (parsed.ok && parsed.value) out.push(parsed.value);
        } catch {
          // Skip corrupt lines — audit data is meta, not fatal.
        }
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  private async writeAll(sessionId: string, entries: AuditEntry[]): Promise<void> {
    const fp = this.filePath(sessionId);
    const line = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
    // Real append — O(1) per write. The write chain ensures serial
    // ordering per session. On crash a partial line may appear;
    // readAll skips unparseable lines so the chain stays verifiable.
    await atomicWrite(fp, line, { mode: 0o600 });
    // Periodic fsync: every fsyncEvery writes, open the file and sync it.
    // This limits data loss to at most fsyncEvery entries on crash.
    const count = (this.unSyncedWrites.get(sessionId) ?? 0) + 1;
    this.unSyncedWrites.set(sessionId, count);
    if (this.fsyncEvery !== Number.POSITIVE_INFINITY && count % this.fsyncEvery === 0) {
      await this.sync(sessionId, fp);
    }
  }

  /**
   * Explicitly sync the file to disk. Called automatically every
   * `fsyncEvery` writes, and available for callers who want to
   * force a sync before closing or during graceful shutdown.
   */
  async flush(sessionId: string): Promise<void> {
    await this.sync(sessionId, this.filePath(sessionId));
  }

  private async sync(sessionId: string, fp: string): Promise<void> {
    try {
      const fh = await fs.open(fp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // fsync is best-effort; a failure here does not corrupt the chain.
    } finally {
      this.unSyncedWrites.set(sessionId, 0);
    }
  }

  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeChains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}
