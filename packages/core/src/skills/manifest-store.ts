import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface InstalledSkillEntry {
  name: string;
  /** Source identifier, e.g. "github:user/repo" */
  source: string;
  /** Git ref that was installed (branch, tag, commit) */
  ref: string;
  /** Installation scope */
  scope: 'project' | 'user';
  /** Project hash — only set when scope=project */
  projectHash?: string;
  /** ISO 8601 timestamp */
  installedAt: string;
  /** List of files that were installed (relative to skill dir) */
  files: string[];
}

export interface ManifestData {
  skills: InstalledSkillEntry[];
}

export class SkillManifestStore {
  private readonly manifestPath: string;
  private cache?: ManifestData;

  constructor(manifestPath: string) {
    this.manifestPath = manifestPath;
  }

  async read(): Promise<ManifestData> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.manifestPath, 'utf8');
      const data = JSON.parse(raw) as ManifestData;
      if (!Array.isArray(data.skills)) {
        this.cache = { skills: [] };
      } else {
        this.cache = data;
      }
    } catch {
      this.cache = { skills: [] };
    }
    return this.cache;
  }

  async write(data: ManifestData): Promise<void> {
    const dir = path.dirname(this.manifestPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.manifestPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    this.cache = data;
  }

  async addEntry(entry: InstalledSkillEntry): Promise<void> {
    const data = await this.read();
    // Remove existing entry with the same name + scope
    data.skills = data.skills.filter(
      (s) => !(s.name === entry.name && s.scope === entry.scope),
    );
    data.skills.push(entry);
    await this.write(data);
  }

  async removeEntry(name: string, scope: 'project' | 'user'): Promise<boolean> {
    const data = await this.read();
    const before = data.skills.length;
    data.skills = data.skills.filter(
      (s) => !(s.name === name && s.scope === scope),
    );
    if (data.skills.length === before) return false;
    await this.write(data);
    return true;
  }

  async findByName(name: string): Promise<InstalledSkillEntry[]> {
    const data = await this.read();
    return data.skills.filter((s) => s.name === name);
  }

  async findBySource(source: string): Promise<InstalledSkillEntry[]> {
    const data = await this.read();
    return data.skills.filter((s) => s.source === source);
  }

  async listAll(): Promise<InstalledSkillEntry[]> {
    const data = await this.read();
    return data.skills;
  }

  /** Invalidate the in-memory cache (e.g. after external file changes). */
  invalidateCache(): void {
    this.cache = undefined;
  }
}
