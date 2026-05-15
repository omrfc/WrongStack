import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MemoryScope, MemoryStore } from '../types/memory.js';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

const MAX_BYTES_TOTAL = 32_000; // ~8K tokens

export interface MemoryStoreOptions {
  paths: WstackPaths;
}

/**
 * Three scopes:
 *   project-agents → <project>/.wrongstack/AGENTS.md     (committed)
 *   project-memory → ~/.wrongstack/projects/<hash>/memory.md   (per-project agent notes)
 *   user-memory    → ~/.wrongstack/memory.md             (global personal memory)
 */
export class DefaultMemoryStore implements MemoryStore {
  private readonly files: Record<MemoryScope, string>;
  /**
   * Per-scope serialization queue. `remember` / `forget` / `consolidate` /
   * `clear` are read-modify-write against a single file; without a lock,
   * two concurrent calls on the same scope can read the same baseline and
   * the later write silently drops the earlier entry. We chain each
   * mutation onto the prior promise for the same scope so they run in
   * issue order. Different scopes still proceed in parallel.
   *
   * The chain tracks only the last pending write. If a write fails, its
   * error is caught and swallowed (line 43) so the chain stays alive for
   * subsequent calls. A crash between atomicWrite() and backup copy leaves
   * the file at its new content with no backup — acceptable for an optional
   * backup whose worst case is losing a memory consolidation pass.
   */
  private readonly writeChain = new Map<MemoryScope, Promise<unknown>>();

  constructor(opts: MemoryStoreOptions) {
    this.files = {
      'project-agents': opts.paths.inProjectAgentsFile,
      'project-memory': opts.paths.projectMemory,
      'user-memory': opts.paths.globalMemory,
    };
  }

  private async runSerialized<T>(scope: MemoryScope, work: () => Promise<T>): Promise<T> {
    const prior = this.writeChain.get(scope) ?? Promise.resolve();
    // Swallow prior errors here so one failed write doesn't poison the
    // chain — the failed call has already rejected to its own caller.
    const next = prior.catch(() => undefined).then(work);
    this.writeChain.set(scope, next);
    try {
      return await next;
    } finally {
      // Clear the chain reference once this call finishes so memory doesn't
      // grow unboundedly across long-lived processes. If another call
      // queued behind us, it's already captured in next; the map entry
      // serves only as the "what should the next caller wait on" pointer.
      if (this.writeChain.get(scope) === next) {
        this.writeChain.delete(scope);
      }
    }
  }

  async readAll(): Promise<string> {
    const parts: string[] = [];
    for (const scope of ['project-agents', 'project-memory', 'user-memory'] as MemoryScope[]) {
      const body = await this.read(scope);
      if (body.trim()) parts.push(`## ${labelOf(scope)}\n\n${body.trim()}`);
    }
    return parts.join('\n\n');
  }

  async read(scope: MemoryScope): Promise<string> {
    try {
      return await fs.readFile(this.files[scope], 'utf8');
    } catch {
      return '';
    }
  }

  async remember(text: string, scope: MemoryScope = 'project-memory'): Promise<void> {
    return this.runSerialized(scope, async () => {
      const file = this.files[scope];
      await ensureDir(path.dirname(file));
      let existing = '';
      try {
        existing = await fs.readFile(file, 'utf8');
      } catch {
        // new file
      }
      const ts = new Date().toISOString();
      // Use a stable ID so forget() can target exact entries regardless of content.
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const entry = `\n- [${ts}] ${id} ${text.replace(/\n/g, ' ')}\n`;
      const next = existing.trim()
        ? existing.replace(/\n+$/, '') + entry
        : `# WrongStack Memory\n${entry}`;
      await atomicWrite(file, next);
      const buf = Buffer.byteLength(next, 'utf8');
      if (buf > MAX_BYTES_TOTAL) {
        // consolidate enqueues onto the same chain — call directly into the
        // inner implementation to avoid deadlocking on our own queue slot.
        await this.consolidateUnsafe(scope);
      }
    });
  }

  async forget(query: string, scope: MemoryScope = 'project-memory'): Promise<number> {
    return this.runSerialized(scope, async () => this.forgetUnsafe(query, scope));
  }

  private async forgetUnsafe(query: string, scope: MemoryScope): Promise<number> {
    const file = this.files[scope];
    let existing: string;
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch {
      return 0;
    }
    // Match by unique ID suffix (mem_<ts>_<rand>) embedded in the entry.
    // Fall back to case-insensitive content match for entries without an ID.
    const needle = query.toLowerCase();
    const idMatcher = /mem_\d+_\w+/;
    let removed = 0;
    const lines = existing.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) return true;
      // If the query looks like an ID, match exactly; otherwise match content.
      if (idMatcher.test(query)) {
        // The entry ID appears right after the timestamp: "- [ts] mem_<ts>_<rand> ..."
        const afterBracket = trimmed.indexOf('] ');
        if (afterBracket !== -1) {
          const afterTs = trimmed.slice(afterBracket + 2);
          const entryIdMatch = /^mem_\d+_\w+/.exec(afterTs);
          if (entryIdMatch && entryIdMatch[0] === query) {
            removed++;
            return false;
          }
        }
      }
      // Fall back to content-based match (still useful for project-agents legacy entries)
      if (trimmed.toLowerCase().includes(needle)) {
        removed++;
        return false;
      }
      return true;
    });
    if (removed > 0) {
      await atomicWrite(file, lines.join('\n'));
    }
    return removed;
  }

  async consolidate(scope: MemoryScope): Promise<void> {
    return this.runSerialized(scope, async () => this.consolidateUnsafe(scope));
  }

  private async consolidateUnsafe(scope: MemoryScope): Promise<void> {
    const file = this.files[scope];
    let existing: string;
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    // Dedupe identical bullet lines (case-insensitive, ignoring per-entry
    // metadata: the leading "[timestamp]" and the "mem_<ts>_<rand>" ID).
    const seen = new Set<string>();
    const lines = existing.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) return true;
      const norm = trimmed
        .replace(/\[[^\]]+\]/, '')
        .replace(/\bmem_\d+_\w+\s*/, '')
        .trim()
        .toLowerCase();
      if (seen.has(norm)) return false;
      seen.add(norm);
      return true;
    });
    const next = lines.join('\n');
    // Backup BEFORE the write so a crash leaves the original intact and
    // the backup reflects the pre-consolidation state. Best-effort so
    // ENOENT (new file) or permission errors don't block consolidation.
    const backup = `${file}.bak.${Date.now()}`;
    try {
      await fs.copyFile(file, backup);
    } catch {
      // best-effort
    }
    try {
      await atomicWrite(file, next);
    } catch {
      // If the write fails, the original file is untouched (atomicWrite
      // does write-to-temp + rename). We still keep the backup.
      return;
    }
  }

  async clear(scope?: MemoryScope): Promise<void> {
    if (scope) {
      await this.runSerialized(scope, async () => atomicWrite(this.files[scope], ''));
      return;
    }
    // Clear-all: serialize each scope independently so different scopes
    // still run in parallel, but each one waits for its own pending writes.
    await Promise.all(
      (['project-agents', 'project-memory', 'user-memory'] as MemoryScope[]).map((s) =>
        this.runSerialized(s, async () => atomicWrite(this.files[s], '')),
      ),
    );
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
