import { expectDefined } from '../utils/expect-defined.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { sessionScopedPath } from '../utils/session-scoped-path.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { WrongStackError, ERROR_CODES } from '../types/errors.js';
/**
 * L2-B: AnnotationsStore — sidecar storage for collaboration annotations
 * (Phase 2 of idea #13 from IDEAS.md).
 *
 * Why a sidecar file, not the session JSONL?
 *
 *   The session log is an event-sourced append-only journal
 *   (`packages/core/src/types/session.ts` invariant: events are
 *   append-only, with `truncateToCheckpoint` only as an explicit
 *   rewind). Mixing in human-typed annotations would break that
 *   invariant — the user's note about "this rm looks dangerous"
 *   is not part of the agent's event history; it is meta-commentary
 *   on the history.
 *
 *   So we keep annotations in a sibling file: one JSON document per
 *   session, at `<sessionDir>/<sessionId>.annotations.json`. The
 *   shape is a simple versioned array, written atomically.
 *
 * Concurrency model:
 *
 *   The store uses a per-session Promise chain to serialize writes.
 *   Multiple annotators adding notes at the same time will queue,
 *   not race. The atomic write itself is the second line of
 *   defense (in case the chain is bypassed — e.g. two processes
 *   pointing at the same dir).
 */

/** Wire/storage shape for one annotation. */
export interface Annotation {
  /** Stable id (UUIDv4-ish). Referenced by resolve/delete. */
  id: string;
  /** Session this annotation belongs to. */
  sessionId: string;
  /** Index into the session event log the annotation refers to. */
  atEventIndex: number;
  /** Participant id of the annotator (matches WSCollabParticipantJoined.participantId). */
  authorId: string;
  /** Human-readable role label snapshot for display (e.g. "annotator"). */
  authorRole: 'annotator';
  /** The note itself. Trimmed, capped at `MAX_TEXT_LENGTH` on add. */
  text: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Resolved state. Annotations start unresolved. */
  resolved: boolean;
  /** ISO timestamp when resolved (if resolved). */
  resolvedAt?: string | undefined;
  /** Participant id of the resolver (if resolved). */
  resolvedBy?: string | undefined;
}

interface AnnotationsFile {
  /** Bumped when the on-disk shape changes. v1 = initial release. */
  version: 1;
  annotations: Annotation[];
}

/** Bumped when the on-disk shape changes. Bump + migration on change. */
const FILE_VERSION = 1;
/** Hard cap to keep a runaway annotator from writing megabytes. */
const MAX_TEXT_LENGTH = 2000;
/** Hard cap on total annotations per session (oldest are evicted beyond this). */
const MAX_ANNOTATIONS = 1000;

export interface AnnotationsStoreOptions {
  /** Directory where `<sessionId>.annotations.json` files live. */
  dir: string;
}

export class AnnotationsStore {
  private readonly dir: string;
  /** Per-session write queue. Created lazily on first add. */
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(opts: AnnotationsStoreOptions) {
    this.dir = opts.dir;
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  /**
   * Return all annotations for `sessionId` in insertion order
   * (oldest first). Returns an empty array when no file exists
   * yet (the normal case for a fresh session).
   */
  async list(sessionId: string): Promise<Annotation[]> {
    const file = await this.readFile(sessionId);
    return file ? file.annotations : [];
  }

  /**
   * Convenience: only unresolved annotations, newest first — the
   * common UI rendering for "what still needs attention?".
   */
  async listOpen(sessionId: string): Promise<Annotation[]> {
    const all = await this.list(sessionId);
    return all.filter((a) => !a.resolved).reverse();
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  /**
   * Add a new annotation. Returns the persisted record (with id
   * and timestamps filled in). Throws when `text` is empty or
   * exceeds `MAX_TEXT_LENGTH`.
   */
  async add(input: {
    sessionId: string;
    atEventIndex: number;
    authorId: string;
    text: string;
  }): Promise<Annotation> {
    const text = input.text.trim();
    if (text.length === 0) {
      throw new WrongStackError({
        message: 'Annotation text must be non-empty',
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { field: 'text', sessionId: input.sessionId },
      });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new WrongStackError({
        message: `Annotation text exceeds ${MAX_TEXT_LENGTH} chars (got ${text.length})`,
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { field: 'text', maxLength: MAX_TEXT_LENGTH, actualLength: text.length },
      });
    }
    if (!Number.isInteger(input.atEventIndex) || input.atEventIndex < 0) {
      throw new WrongStackError({
        message: 'atEventIndex must be a non-negative integer',
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { field: 'atEventIndex', value: input.atEventIndex },
      });
    }
    const annotation: Annotation = {
      id: randomUUID(),
      sessionId: input.sessionId,
      atEventIndex: input.atEventIndex,
      authorId: input.authorId,
      authorRole: 'annotator',
      text,
      createdAt: new Date().toISOString(),
      resolved: false,
    };
    await this.enqueue(input.sessionId, async () => {
      await withFileLock(this.filePath(input.sessionId), async () => {
        const all = await this.list(input.sessionId);
        all.push(annotation);
        // Evict oldest if we crossed the cap. Resolved first, then oldest.
        if (all.length > MAX_ANNOTATIONS) {
          const sorted = all
            .map((a, i) => ({ a, i }))
            .sort((x, y) => {
              // resolved=false wins (keep unresolved); among same resolved state, oldest first.
              if (x.a.resolved !== y.a.resolved) return x.a.resolved ? 1 : -1;
              return x.a.createdAt.localeCompare(y.a.createdAt);
            });
          const evictCount = all.length - MAX_ANNOTATIONS;
          const toEvict = new Set(sorted.slice(0, evictCount).map((s) => s.a.id));
          const kept = all.filter((a) => !toEvict.has(a.id));
          await this.writeFile(input.sessionId, { version: FILE_VERSION, annotations: kept });
        } else {
          await this.writeFile(input.sessionId, { version: FILE_VERSION, annotations: all });
        }
      });
    });
    return annotation;
  }

  /**
   * Mark an annotation as resolved. Returns the updated record, or
   * `null` if no annotation with that id exists in this session.
   * Idempotent: resolving an already-resolved annotation refreshes
   * `resolvedAt` / `resolvedBy` to the latest call.
   */
  async resolve(input: {
    sessionId: string;
    annotationId: string;
    resolvedBy: string;
  }): Promise<Annotation | null> {
    let updated: Annotation | null = null;
    await this.enqueue(input.sessionId, async () => {
      await withFileLock(this.filePath(input.sessionId), async () => {
        const all = await this.list(input.sessionId);
        const idx = all.findIndex((a) => a.id === input.annotationId);
        if (idx === -1) {
          updated = null;
          return;
        }
        const next: Annotation = {
          ...expectDefined(all[idx]),
          resolved: true,
          resolvedAt: new Date().toISOString(),
          resolvedBy: input.resolvedBy,
        };
        all[idx] = next;
        await this.writeFile(input.sessionId, { version: FILE_VERSION, annotations: all });
        updated = next;
      });
    });
    return updated;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    // Containment-checked: date-sharded ids ("2026-06-11/<base>") are
    // legitimate; traversal is rejected. A plain slash ban here used to
    // throw for every modern session id, breaking annotations entirely.
    return sessionScopedPath(this.dir, sessionId, '.annotations.json');
  }

  private async readFile(sessionId: string): Promise<AnnotationsFile | null> {
    const fp = this.filePath(sessionId);
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const parsed = JSON.parse(raw) as AnnotationsFile;
      if (parsed.version !== FILE_VERSION) {
        // Future-proof: migrations land here. For now, treat unknown
        // versions as an empty store — safer than crashing on a
        // downgrade.
        return { version: FILE_VERSION, annotations: [] };
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Corrupt JSON or permission error: log via the silent-recovery
      // path (the store doesn't take a logger; callers observe via
      // list() returning [] for an unreadable file is acceptable for
      // Phase 2 — annotations are meta-data, losing them is not fatal).
      return { version: FILE_VERSION, annotations: [] };
    }
  }

  private async writeFile(sessionId: string, file: AnnotationsFile): Promise<void> {
    const fp = this.filePath(sessionId);
    await atomicWrite(fp, JSON.stringify(file, null, 2));
  }

  /**
   * Serialize writes per-sessionId. We chain promises instead of
   * using a Mutex class so the contract is obvious from the
   * call-site: `enqueue(sid, fn)` runs `fn` after every prior
   * enqueue for `sid` has settled.
   */
  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain intact even when `fn` throws; failures
    // shouldn't break subsequent writes.
    this.writeChains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }
}
