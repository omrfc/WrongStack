import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

export interface PromptEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptStore {
  list(): Promise<PromptEntry[]>;
  get(id: string): Promise<PromptEntry | null>;
  save(entry: PromptEntry): Promise<void>;
  delete(id: string): Promise<boolean>;
  find(query: string): Promise<PromptEntry[]>;
}

interface RawPromptFile {
  version: 1;
  entry: PromptEntry;
}

export class DefaultPromptStore implements PromptStore {
  private readonly dir: string;

  constructor(paths: WstackPaths) {
    this.dir = paths.globalPrompts;
  }

  async list(): Promise<PromptEntry[]> {
    await ensureDir(this.dir);
    let entries: PromptEntry[] = [];
    try {
      const files = await fs.readdir(this.dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw: RawPromptFile = JSON.parse(
            await fs.readFile(path.join(this.dir, file), 'utf8'),
          );
          entries.push(raw.entry);
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // dir doesn't exist yet
    }
    return entries.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async get(id: string): Promise<PromptEntry | null> {
    const file = path.join(this.dir, `${id}.json`);
    try {
      const raw: RawPromptFile = JSON.parse(await fs.readFile(file, 'utf8'));
      return raw.entry;
    } catch {
      return null;
    }
  }

  async save(entry: PromptEntry): Promise<void> {
    await ensureDir(this.dir);
    const file = path.join(this.dir, `${entry.id}.json`);
    const raw: RawPromptFile = { version: 1, entry };
    await atomicWrite(file, JSON.stringify(raw, null, 2));
  }

  async delete(id: string): Promise<boolean> {
    const file = path.join(this.dir, `${id}.json`);
    try {
      await fs.unlink(file);
      return true;
    } catch {
      return false;
    }
  }

  async find(query: string): Promise<PromptEntry[]> {
    const all = await this.list();
    const lower = query.toLowerCase();
    return all.filter(
      (e) =>
        e.title.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower) ||
        e.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  /** Create a new entry and return it. Does NOT persist — call save() afterwards. */
  createNew(title: string, content: string, tags: string[] = []): PromptEntry {
    const now = new Date().toISOString();
    return {
      id: randomUUID().slice(0, 8),
      title,
      content,
      tags,
      createdAt: now,
      updatedAt: now,
    };
  }
}