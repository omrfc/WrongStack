import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SkillLoader } from '../types/skill.js';
import { downloadGitHubTarball, parseSkillRef } from './github-fetcher.js';
import { type InstalledSkillEntry, SkillManifestStore } from './manifest-store.js';

export interface SkillInstallerOptions {
  /** Path to the manifest file (~/.wrongstack/installed-skills.json) */
  manifestPath: string;
  /** Path to project-level skills dir (<project>/.wrongstack/skills/) */
  projectSkillsDir: string;
  /** Path to user-global skills dir (~/.wrongstack/skills/) */
  globalSkillsDir: string;
  /** Current project hash (for manifest tracking) */
  projectHash: string;
  /** Skill loader — cache will be invalidated after mutations */
  skillLoader?: SkillLoader;
  /** Logger for status messages */
  log?: (msg: string) => void;
}

export interface InstallResult {
  name: string;
  path: string;
  scope: 'project' | 'user';
  source: string;
  ref: string;
  skillCount: number;
}

export interface UpdateResult {
  updated: Array<{ name: string; oldRef: string; newRef: string }>;
  unchanged: string[];
  errors: Array<{ name: string; error: string }>;
}

const MAX_SKILL_FILE_SIZE = 100 * 1024; // 100KB

export class SkillInstaller {
  private readonly opts: SkillInstallerOptions;
  private readonly manifest: SkillManifestStore;

  constructor(opts: SkillInstallerOptions) {
    this.opts = opts;
    this.manifest = new SkillManifestStore(opts.manifestPath);
  }

  /**
   * Install skills from a GitHub repository.
   * Supports both single-skill repos (SKILL.md at root) and multi-skill repos (skills/ subdirectory).
   */
  async install(refInput: string, opts?: { global?: boolean }): Promise<InstallResult[]> {
    const parsed = parseSkillRef(refInput);
    const scope: 'project' | 'user' = opts?.global ? 'user' : 'project';
    const targetDir = scope === 'project' ? this.opts.projectSkillsDir : this.opts.globalSkillsDir;
    const source = `github:${parsed.owner}/${parsed.repo}`;

    this.opts.log?.(`Downloading ${parsed.owner}/${parsed.repo}@${parsed.ref}...`);

    const { tempDir } = await downloadGitHubTarball(parsed);

    try {
      // Detect skill structure
      const skills = await this.detectSkills(tempDir);

      if (skills.length === 0) {
        throw new Error(
          'No skills found in repository. Expected SKILL.md at root or skills/ subdirectory.',
        );
      }

      const results: InstallResult[] = [];

      for (const skill of skills) {
        // Check for overwrite
        const existing = await this.manifest.findByName(skill.name);
        const existingInScope = existing.find((e) => e.scope === scope);
        if (existingInScope) {
          this.opts.log?.(`Overwriting existing skill "${skill.name}" (${scope})...`);
          await this.removeSkillFiles(skill.name, scope);
        }

        // Copy skill files
        const destDir = path.join(targetDir, skill.name);
        await fs.mkdir(destDir, { recursive: true });
        const copiedFiles: string[] = [];

        for (const file of skill.files) {
          const srcPath = path.join(skill.baseDir, file);
          const destPath = path.join(destDir, file);

          // Path traversal check
          const resolved = path.resolve(destPath);
          if (!resolved.startsWith(path.resolve(destDir))) {
            throw new Error(`Path traversal detected in skill file: ${file}`);
          }

          // Size check
          const stat = await fs.stat(srcPath);
          if (stat.size > MAX_SKILL_FILE_SIZE) {
            throw new Error(
              `Skill file "${file}" is too large (${(stat.size / 1024).toFixed(1)}KB). Max: ${MAX_SKILL_FILE_SIZE / 1024}KB`,
            );
          }

          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.copyFile(srcPath, destPath);
          copiedFiles.push(file);
        }

        // Write manifest entry
        const entry: InstalledSkillEntry = {
          name: skill.name,
          source,
          ref: parsed.ref,
          scope,
          projectHash: scope === 'project' ? this.opts.projectHash : undefined,
          installedAt: new Date().toISOString(),
          files: copiedFiles,
        };
        await this.manifest.addEntry(entry);

        results.push({
          name: skill.name,
          path: destDir,
          scope,
          source,
          ref: parsed.ref,
          skillCount: 1,
        });
      }

      this.invalidateLoaderCache();
      return results;
    } finally {
      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Update installed skills.
   * - No args: update all
   * - Name: update that specific skill
   * - Name + newRef: update to a different ref
   */
  async update(
    nameOrRef?: string,
    _opts?: { global?: boolean },
  ): Promise<UpdateResult> {
    const result: UpdateResult = { updated: [], unchanged: [], errors: [] };
    const allEntries = await this.manifest.listAll();

    let targets: InstalledSkillEntry[];
    if (nameOrRef) {
      // Check if it's a name or a ref (user/repo@ref)
      const byName = allEntries.filter((e) => e.name === nameOrRef);
      if (byName.length > 0) {
        targets = byName;
      } else {
        // Treat as a new ref — find matching source
        try {
          const parsed = parseSkillRef(nameOrRef);
          const source = `github:${parsed.owner}/${parsed.repo}`;
          targets = allEntries.filter((e) => e.source === source);
          if (targets.length === 0) {
            result.errors.push({
              name: nameOrRef,
              error: `No installed skills found matching "${nameOrRef}"`,
            });
            return result;
          }
        } catch {
          result.errors.push({
            name: nameOrRef,
            error: `Invalid reference: ${nameOrRef}`,
          });
          return result;
        }
      }
    } else {
      targets = allEntries;
    }

    // Group by source to avoid downloading the same repo multiple times
    const bySource = new Map<string, InstalledSkillEntry[]>();
    for (const entry of targets) {
      const key = `${entry.source}@${entry.ref}`;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)!.push(entry);
    }

    for (const [, entries] of bySource) {
      const first = entries[0]!;
      const scope = first.scope;
      const isGlobal = scope === 'user';

      try {
        // Parse the original source to get the ref
        const sourceRepo = first.source.replace('github:', '');
        let refToInstall = first.ref;

        // If nameOrRef looks like a new ref, use it
        if (nameOrRef && !allEntries.find((e) => e.name === nameOrRef)) {
          try {
            const parsed = parseSkillRef(nameOrRef);
            refToInstall = parsed.ref;
          } catch {
            // keep original ref
          }
        }

        this.opts.log?.(`Updating ${first.source}@${refToInstall}...`);
        const results = await this.install(`${sourceRepo}@${refToInstall}`, { global: isGlobal });

        for (const r of results) {
          result.updated.push({
            name: r.name,
            oldRef: first.ref,
            newRef: refToInstall,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const entry of entries) {
          result.errors.push({ name: entry.name, error: msg });
        }
      }
    }

    return result;
  }

  /**
   * Uninstall a skill by name.
   */
  async uninstall(name: string, opts?: { global?: boolean }): Promise<void> {
    const scope: 'project' | 'user' = opts?.global ? 'user' : 'project';
    const entries = await this.manifest.findByName(name);
    const entry = entries.find((e) => e.scope === scope);

    if (!entry) {
      throw new Error(`Skill "${name}" is not installed${scope === 'user' ? ' (global)' : ''}.`);
    }

    // Remove files
    await this.removeSkillFiles(name, scope);

    // Remove from manifest
    await this.manifest.removeEntry(name, scope);
    this.invalidateLoaderCache();
  }

  /**
   * List all installed skills from the manifest.
   */
  async listInstalled(): Promise<InstalledSkillEntry[]> {
    return this.manifest.listAll();
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Detect skills in an extracted repository.
   * Returns an array of detected skills with their files.
   */
  private async detectSkills(
    baseDir: string,
  ): Promise<Array<{ name: string; baseDir: string; files: string[] }>> {
    const results: Array<{ name: string; baseDir: string; files: string[] }> = [];

    // Check for SKILL.md at root (single-skill repo)
    const rootSkillMd = path.join(baseDir, 'SKILL.md');
    try {
      await fs.access(rootSkillMd);
      const content = await fs.readFile(rootSkillMd, 'utf8');
      const meta = parseFrontmatter(content);
      if (meta.name && meta.description) {
        results.push({
          name: meta.name,
          baseDir,
          files: ['SKILL.md'],
        });
        return results; // Single-skill repo — don't look for skills/
      }
    } catch {
      // No root SKILL.md
    }

    // Check for skills/ subdirectory (multi-skill repo)
    const skillsDir = path.join(baseDir, 'skills');
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
        try {
          const content = await fs.readFile(skillFile, 'utf8');
          const meta = parseFrontmatter(content);
          if (meta.name && meta.description) {
            // Collect all files in the skill directory
            const skillDir = path.join(skillsDir, entry.name);
            const files = await collectFiles(skillDir, skillDir);
            results.push({
              name: meta.name,
              baseDir: skillDir,
              files,
            });
          }
        } catch {
          // Skip malformed skills
        }
      }
    } catch {
      // No skills/ directory
    }

    return results;
  }

  /**
   * Remove all files for an installed skill.
   */
  private async removeSkillFiles(name: string, scope: 'project' | 'user'): Promise<void> {
    const targetDir =
      scope === 'project' ? this.opts.projectSkillsDir : this.opts.globalSkillsDir;
    const skillDir = path.join(targetDir, name);
    await fs.rm(skillDir, { recursive: true, force: true });
  }

  /**
   * Invalidate the skill loader's cache so newly installed skills appear.
   */
  private invalidateLoaderCache(): void {
    // The SkillLoader interface has a cache internally.
    // We access it via the 'any' cast to call invalidateCache if available.
    const loader = this.opts.skillLoader as unknown as { invalidateCache?: () => void };
    if (loader && typeof loader.invalidateCache === 'function') {
      loader.invalidateCache();
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(raw: string): Frontmatter {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return {};
  const block = raw.slice(4, end);
  const out: Frontmatter = {};
  let key: keyof Frontmatter | null = null;
  let value: string[] = [];
  const flush = () => {
    if (key) {
      out[key] = value.join('\n').trim();
    }
    key = null;
    value = [];
  };
  for (const line of block.split('\n')) {
    const m = /^([a-zA-Z_]+):\s*(\|?)\s*(.*)$/.exec(line);
    if (m) {
      flush();
      key = (m[1] ?? '') as keyof Frontmatter;
      const pipe = m[2];
      const rest = m[3] ?? '';
      if (pipe === '|') {
        value = [];
      } else if (rest) {
        value = [rest];
      } else {
        value = [];
      }
    } else if (key) {
      value.push(line.replace(/^\s+/, ''));
    }
  }
  flush();
  return out;
}

/**
 * Recursively collect all files in a directory (relative paths).
 */
async function collectFiles(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...(await collectFiles(fullPath, baseDir)));
    } else {
      results.push(relPath);
    }
  }
  return results;
}
