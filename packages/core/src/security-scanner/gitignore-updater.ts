import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../utils/atomic-write.js';

export interface GitignoreUpdaterOptions {
  gitignorePath: string;
  entries: string[];
}

const DEFAULT_OPTIONS: GitignoreUpdaterOptions = {
  gitignorePath: '.gitignore',
  entries: ['security-reports/', 'security-reports/*'],
};

export class GitignoreUpdater {
  private options: GitignoreUpdaterOptions;

  constructor(options: Partial<GitignoreUpdaterOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async update(): Promise<{ added: string[]; existing: string[]; errors: string[] }> {
    const added: string[] = [];
    const existing: string[] = [];
    const errors: string[] = [];

    try {
      const content = await readFile(this.options.gitignorePath, 'utf-8');
      const lines = new Set(content.split(/\r?\n/).map((l) => l.trim()));

      for (const entry of this.options.entries) {
        if (lines.has(entry)) {
          existing.push(entry);
        } else {
          lines.add(entry);
          added.push(entry);
        }
      }

      if (added.length > 0) {
        const newContent = [...lines].filter(Boolean).join('\n') + '\n';
        // atomicWrite: .gitignore is a user-tracked source file — a torn
        // write here would commit a corrupt file to the user's repo.
        await atomicWrite(this.options.gitignorePath, newContent);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // .gitignore doesn't exist, create it
        const content = this.options.entries.join('\n') + '\n';
        await atomicWrite(this.options.gitignorePath, content);
        added.push(...this.options.entries);
      } else {
        errors.push(`Failed to update .gitignore: ${err}`);
      }
    }

    return { added, existing, errors };
  }

  async isEntryIgnored(entry: string): Promise<boolean> {
    try {
      const content = await readFile(this.options.gitignorePath, 'utf-8');
      const lines = content.split(/\r?\n/).map((l) => l.trim());
      return lines.includes(entry);
    } catch {
      return false;
    }
  }
}

export const defaultGitignoreUpdater = new GitignoreUpdater();