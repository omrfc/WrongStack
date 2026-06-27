import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';

export interface PromptUsage {
  count: number;
  lastUsedAt: string;
}

interface RawUsageFile {
  version: 1;
  usage: Record<string, PromptUsage>;
}

/**
 * Tracks how often each prompt is inserted, keyed by slug, in a single JSON
 * file (`~/.wrongstack/prompt-usage.json`). Kept SEPARATE from the prompt
 * entries so usage can be recorded for read-only builtin prompts without
 * copy-on-writing them into the user layer. Surfaces "recent / most-used"
 * views and a gentle search-ranking boost.
 */
export class PromptUsageStore {
  constructor(private readonly file: string) {}

  async load(): Promise<Record<string, PromptUsage>> {
    try {
      const raw: RawUsageFile = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && raw.usage && typeof raw.usage === 'object') {
        return raw.usage;
      }
    } catch {
      // missing or corrupt → empty
    }
    return {};
  }

  async record(slug: string, at: string = new Date().toISOString()): Promise<PromptUsage> {
    const usage = await this.load();
    const prev = usage[slug];
    const next: PromptUsage = { count: (prev?.count ?? 0) + 1, lastUsedAt: at };
    usage[slug] = next;
    await ensureDir(path.dirname(this.file));
    await atomicWrite(this.file, JSON.stringify({ version: 1, usage } satisfies RawUsageFile, null, 2));
    return next;
  }

  async get(slug: string): Promise<PromptUsage | undefined> {
    return (await this.load())[slug];
  }

  /** Slugs ordered by most-recently-used (then by count), capped at `limit`. */
  async recent(limit = 15): Promise<{ slug: string; usage: PromptUsage }[]> {
    const usage = await this.load();
    return Object.entries(usage)
      .map(([slug, u]) => ({ slug, usage: u }))
      .sort(
        (a, b) =>
          new Date(b.usage.lastUsedAt).getTime() - new Date(a.usage.lastUsedAt).getTime() ||
          b.usage.count - a.usage.count,
      )
      .slice(0, limit);
  }

  /** Slugs ordered by usage count (then recency), capped at `limit`. */
  async top(limit = 15): Promise<{ slug: string; usage: PromptUsage }[]> {
    const usage = await this.load();
    return Object.entries(usage)
      .map(([slug, u]) => ({ slug, usage: u }))
      .sort(
        (a, b) =>
          b.usage.count - a.usage.count ||
          new Date(b.usage.lastUsedAt).getTime() - new Date(a.usage.lastUsedAt).getTime(),
      )
      .slice(0, limit);
  }
}
