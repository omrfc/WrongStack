import type {
  MemoryClearedPayload,
  MemoryConsolidatedPayload,
  MemoryEntry,
  MemoryForgottenPayload,
  MemoryRelevanceContext,
  MemoryRememberedPayload,
  MemoryScope,
  MemoryStore,
  ScoredEntry,
} from '../types/memory.js';
import type { EventBus } from '../kernel/events.js';
import type { WstackPaths } from '../utils/wstack-paths.js';
import { type MemoryBackend, FileMemoryBackend } from './memory-backend.js';

const MAX_BYTES_TOTAL = 32_000; // ~8K tokens

export interface MemoryStoreOptions {
  paths: WstackPaths;
  /**
   * Optional event bus — when provided, mutations emit events so plugins
   * and other subsystems can react to memory changes.
   */
  events?: EventBus | undefined;
  /**
   * Storage backend. Defaults to FileMemoryBackend when omitted.
   * Plugins can register a custom backend (graph, semantic, vector)
   * via the DI container to override storage behavior.
   */
  backend?: MemoryBackend | undefined;
}

/**
 * Three scopes:
 *   project-agents → <project>/.wrongstack/AGENTS.md     (committed)
 *   project-memory → ~/.wrongstack/projects/<hash>/memory.md   (per-project agent notes)
 *   user-memory    → ~/.wrongstack/memory.md             (global personal memory)
 */
export class DefaultMemoryStore implements MemoryStore {
  private readonly files: Record<MemoryScope, string>;
  private readonly events?: EventBus | undefined;
  private readonly backend: MemoryBackend;

  /**
   * Per-scope serialization queue. `remember` / `forget` / `consolidate` /
   * `clear` are read-modify-write against a single file; without a lock,
   * two concurrent calls on the same scope can read the same baseline and
   * the later write silently drops the earlier entry. We chain each
   * mutation onto the prior promise for the same scope so they run in
   * issue order. Different scopes still proceed in parallel.
   *
   * The chain tracks only the last pending write. If a write fails, its
   * error is caught and swallowed so the chain stays alive for subsequent
   * calls. The error is stored in `writeErrors` so callers can learn about
   * it on the next read operation.
   */
  private readonly writeChain = new Map<MemoryScope, Promise<unknown>>();
  /** Last write error per scope — surfaced as warnings on the next readAll(). */
  private readonly writeErrors = new Map<MemoryScope, Error>();

  /**
   * When the global root is a temporary directory (opencode, CI sandboxes),
   * memory files are also mirrored to the project tree so they survive
   * session cleanup. The primary path stays in the temp root for isolation;
   * this backup ensures memory is never lost.
   */
  private readonly persistBackup: boolean;
  private readonly backupDir: string;

  constructor(opts: MemoryStoreOptions) {
    this.files = {
      'project-agents': opts.paths.inProjectAgentsFile,
      'project-memory': opts.paths.projectMemory,
      'user-memory': opts.paths.globalMemory,
    };
    this.events = opts.events;
    this.backend = opts.backend ?? new FileMemoryBackend({ paths: opts.paths });

    // Detect temporary global roots: opencode, CI, test sandboxes.
    // When detected, mirror writes to the project's .wrongstack/ dir.
    const root = opts.paths.globalRoot.toLowerCase();
    this.persistBackup = /[/\\](tmp|temp|cache)[/\\]/.test(root);
    this.backupDir = this.persistBackup
      ? opts.paths.inProjectAgentsFile.replace(/AGENTS\.md$/, 'memory-persist')
      : '';
  }

  /** Expose the backend for plugin introspection and advanced queries. */
  getBackend(): MemoryBackend {
    return this.backend;
  }

  private async runSerialized<T>(scope: MemoryScope, work: () => Promise<T>): Promise<T> {
    const prior = this.writeChain.get(scope) ?? Promise.resolve();
    // Chain: catch errors from the prior write, then run the next work item.
    const next = prior
      .catch((err) => {
        this.writeErrors.set(scope, err as Error);
      })
      .then(() => work());
    this.writeChain.set(scope, next as Promise<unknown>);
    try {
      return await next;
    } catch (err) {
      this.writeErrors.set(scope, err as Error);
      throw err;
    } finally {
      if (this.writeChain.get(scope) === next) {
        this.writeChain.delete(scope);
      }
    }
  }

  async readAll(): Promise<string> {
    const parts: string[] = [];
    for (const scope of ['project-agents', 'project-memory', 'user-memory'] as MemoryScope[]) {
      const writeErr = this.writeErrors.get(scope);
      if (writeErr) {
        parts.push(`> ⚠️ Memory write error (${labelOf(scope)}): ${writeErr.message}`);
      }
      const body = await this.backend.readAll(scope, this.files[scope]);
      if (body.trim()) parts.push(`## ${labelOf(scope)}\n\n${body.trim()}`);
    }
    return parts.join('\n\n');
  }

  async read(scope: MemoryScope): Promise<string> {
    return this.backend.readAll(scope, this.files[scope]);
  }

  /**
   * List entries from a scope, newest first. Delegates to the backend
   * so graph/semantic backends can return enriched or filtered results.
   */
  async list(scope: MemoryScope = 'project-memory', limit?: number): Promise<MemoryEntry[]> {
    return this.backend.list(scope, this.files[scope], limit);
  }

  /**
   * Find memories related to the given text via graph traversal.
   * Falls back to content search when no graph backend is available.
   */
  async findRelated(text: string, scope: MemoryScope = 'project-memory', limit = 5): Promise<MemoryEntry[]> {
    if (this.backend.findRelated) {
      return this.backend.findRelated(scope, this.files[scope], text, limit);
    }
    return this.search(text, scope, limit);
  }

  async search(query: string, scope: MemoryScope = 'project-memory', limit?: number): Promise<MemoryEntry[]> {
    return this.backend.search(scope, query, this.files[scope], limit);
  }

  async remember(
    text: string,
    scope: MemoryScope = 'project-memory',
    metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
  ): Promise<void> {
    const ts = new Date().toISOString();
    return this.runSerialized(scope, async () => {
      const entry: MemoryEntry = { scope, text, ts, ...metadata };
      await this.backend.remember(scope, entry, this.files[scope]);

      // Size check — consolidate if the file exceeds the cap.
      const raw = await this.backend.readAll(scope, this.files[scope]);
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES_TOTAL) {
        const removed = await this.backend.consolidate(scope, this.files[scope]);
        if (removed > 0) {
          this.events?.emit('memory.consolidated', {
            scope,
            removed,
          } satisfies MemoryConsolidatedPayload);
        }
      }

      // Mirror to persistent backup when running in a temp sandbox.
      await this.mirrorBackup(scope);

      this.events?.emit('memory.remembered', {
        scope,
        text,
        ts,
        type: entry.type,
        tags: entry.tags,
        priority: entry.priority,
      } satisfies MemoryRememberedPayload);
    });
  }

  /**
   * Score and rank memories by relevance to the current context.
   * Returns entries with score >= MIN_RELEVANCE_SCORE, sorted highest first.
   */
  async scoreRelevant(
    ctx: MemoryRelevanceContext,
    scope: MemoryScope = 'project-memory',
    limit = 8,
  ): Promise<ScoredEntry[]> {
    const all = await this.list(scope);
    if (all.length === 0) return [];

    const taskWords = ctx.currentTask.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const skillWords = (ctx.activeSkills ?? []).flatMap((s) => s.split('-'));
    const toolWords = (ctx.toolNames ?? []).flatMap((t) => t.toLowerCase().split('_'));
    const now = Date.now();

    const scored: ScoredEntry[] = [];

    for (const entry of all) {
      let score = 0;
      const reasons: string[] = [];
      const textLower = entry.text.toLowerCase();
      const tagsLower = (entry.tags ?? []).map((t) => t.toLowerCase());

      // Word overlap with current task (primary signal)
      let taskHits = 0;
      for (const w of taskWords) {
        if (textLower.includes(w)) { taskHits++; score += 2; }
        if (tagsLower.some((t) => t.includes(w))) { taskHits++; score += 3; }
      }
      if (taskHits > 0) reasons.push(`task match (${taskHits})`);

      // Skill/tool relevance
      let skillHits = 0;
      for (const w of skillWords) {
        if (w.length > 2 && (textLower.includes(w) || tagsLower.some((t) => t.includes(w)))) {
          skillHits++;
        }
      }
      score += skillHits;
      if (skillHits > 0) reasons.push(`skill match (${skillHits})`);

      for (const w of toolWords) {
        if (w.length > 2 && (textLower.includes(w) || tagsLower.some((t) => t.includes(w)))) {
          score += 1;
          reasons.push(`tool mention: ${w}`);
        }
      }

      // Priority boost
      switch (entry.priority) {
        case 'critical': score += 5; reasons.push('critical'); break;
        case 'high':     score += 3; reasons.push('high priority'); break;
        case 'medium':   score += 1; break;
        case 'low':      score -= 2; reasons.push('low priority'); break;
      }

      // Type boost — decisions, conventions, anti-patterns are high-value
      switch (entry.type) {
        case 'decision':    score += 2; reasons.push('decision'); break;
        case 'convention':  score += 2; reasons.push('convention'); break;
        case 'anti_pattern': score += 3; reasons.push('anti-pattern'); break;
        case 'preference':  score += 1; reasons.push('preference'); break;
        case 'reference':   break;
        case 'fact':        break;
      }

      // Recency boost — newer entries get +1, very old get 0
      const ageDays = (now - new Date(entry.ts).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 1) score += 1;
      else if (ageDays > 30) score -= 1;

      // Confidence penalty
      if (entry.confidence !== undefined && entry.confidence < 0.5) {
        score -= 2;
        reasons.push('low confidence');
      }

      // Repetition avoidance — recently accessed entries get slight penalty
      if (entry.lastAccessed) {
        const hoursSinceAccess = (now - new Date(entry.lastAccessed).getTime()) / (1000 * 60 * 60);
        if (hoursSinceAccess < 1) score -= 1;
      }

      if (score > 0) {
        scored.push({
          ...entry,
          score,
          matchReason: reasons.join(', ') || 'keyword match',
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    // Filter to entries that meet the minimum relevance threshold.
    // Critical or high-priority entries always pass.
    const threshold = 2;
    const relevant = scored.filter(
      (s) => s.score >= threshold || s.priority === 'critical' || s.priority === 'high',
    );

    return relevant.slice(0, Math.min(limit, 15));
  }

  async forget(query: string, scope: MemoryScope = 'project-memory'): Promise<number> {
    return this.runSerialized(scope, async () => {
      const removed = await this.backend.forget(scope, query, this.files[scope]);
      if (removed > 0) {
        this.events?.emit('memory.forgotten', {
          scope,
          query,
          removed,
        } satisfies MemoryForgottenPayload);
        await this.mirrorBackup(scope);
      }
      return removed;
    });
  }

  async consolidate(scope: MemoryScope): Promise<void> {
    return this.runSerialized(scope, async () => {
      const removed = await this.backend.consolidate(scope, this.files[scope]);
      if (removed > 0) {
        this.events?.emit('memory.consolidated', {
          scope,
          removed,
        } satisfies MemoryConsolidatedPayload);
        await this.mirrorBackup(scope);
      }
    });
  }

  async clear(scope?: MemoryScope): Promise<void> {
    if (scope) {
      await this.runSerialized(scope, async () => {
        await this.backend.clear(scope, this.files[scope]);
        this.events?.emit('memory.cleared', { scope } satisfies MemoryClearedPayload);
        await this.mirrorBackup(scope);
      });
      return;
    }
    await Promise.all(
      (['project-agents', 'project-memory', 'user-memory'] as MemoryScope[]).map((s) =>
        this.runSerialized(s, async () => {
          await this.backend.clear(s, this.files[s]);
          this.events?.emit('memory.cleared', { scope: s } satisfies MemoryClearedPayload);
          await this.mirrorBackup(s);
        }),
      ),
    );
  }

  /** Mirror current memory content to the persistent backup directory. */
  private async mirrorBackup(scope: MemoryScope): Promise<void> {
    if (!this.persistBackup || scope === 'project-agents') return;
    try {
      const content = await this.backend.readAll(scope, this.files[scope]);
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(this.backupDir, { recursive: true });
      await writeFile(`${this.backupDir}/${scope}.md`, content, 'utf8');
    } catch {
      // best-effort
    }
  }
}

function labelOf(scope: MemoryScope): string {
  switch (scope) {
    case 'project-agents':
      return 'Project AGENTS.md';
    case 'project-memory':
      return 'Project memory';
    case 'user-memory':
      return 'User memory';
  }
}
