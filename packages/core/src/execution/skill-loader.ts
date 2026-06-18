import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SkillEntry, SkillLoader, SkillManifest } from '../types/skill.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

/**
 * Strip YAML frontmatter from a SKILL.md file, returning only the body.
 */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return raw;
  let body = raw.slice(end + 4);
  if (body.startsWith('\n')) body = body.slice(1);
  return body;
}

/**
 * Compact a full skill body for token-saving fallback.
 * Extracts the Overview and Rules sections, trims to ~400 chars max.
 */
function compactSkillBody(body: string): string {
  const sections: string[] = [];
  const overviewMatch = body.match(/##\s*Overview\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  const overview = overviewMatch?.[1];
  if (overview?.trim()) {
    sections.push(overview.trim().slice(0, 200));
  }
  const rulesMatch = body.match(/##\s*Rules\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  const rules = rulesMatch?.[1];
  if (rules?.trim()) {
    const trimmed = rules.trim().slice(0, 350);
    const ruleLines = trimmed
      .split('\n')
      .filter((l) => /^\s*[-*]\s/.test(l) || /^\s*\d+[.)]\s/.test(l))
      .slice(0, 6)
      .join('\n');
    if (ruleLines) sections.push(ruleLines);
  }
  if (sections.length === 0) {
    const first = body.trim().slice(0, 200);
    if (first) sections.push(first);
  }
  const result = sections.join('\n\n');
  return result.length > 450 ? result.slice(0, 447) + '…' : result;
}

export interface SkillLoaderOptions {
  paths: WstackPaths;
  bundledDir?: string | undefined;
}

/**
 * Discovery order (later layers shadow earlier ones at boot, but we walk
 * highest priority first and skip names already seen):
 *   1. Project-committed:  <project>/.wrongstack/skills/
 *   2. User-global:        ~/.wrongstack/skills/
 *   3. Bundled with build: packages/core/skills/
 */
export class DefaultSkillLoader implements SkillLoader {
  private readonly dirs: { dir: string; source: SkillManifest['source'] }[];
  private cache?: SkillManifest[] | undefined;
  private entriesCache?: SkillEntry[] | undefined;
  private readonly bodyCache = new Map<string, string>();

  constructor(opts: SkillLoaderOptions) {
    this.dirs = [
      { dir: opts.paths.inProjectSkills, source: 'project' },
      { dir: opts.paths.globalSkills, source: 'user' },
    ];
    if (opts.bundledDir) {
      this.dirs.push({ dir: opts.bundledDir, source: 'bundled' });
    }
  }

  async list(): Promise<SkillManifest[]> {
    if (this.cache) return this.cache;
    const found: SkillManifest[] = [];
    const seen = new Set<string>();
    for (const { dir, source } of this.dirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const skillFile = path.join(dir, e.name, 'SKILL.md');
          try {
            const raw = await fs.readFile(skillFile, 'utf8');
            const meta = parseFrontmatter(raw);
            if (!meta.name || !meta.description) continue;
            if (seen.has(meta.name)) continue;
            seen.add(meta.name);
            found.push({
              name: meta.name,
              description: meta.description,
              version: meta.version,
              path: skillFile,
              source,
            });
          } catch {
            // skip malformed skill
          }
        }
      } catch {
        // directory may not exist
      }
    }
    this.cache = found;
    return found;
  }

  async find(name: string): Promise<SkillManifest | undefined> {
    const all = await this.list();
    const lower = name.toLowerCase();
    return all.find((s) => s.name.toLowerCase() === lower);
  }

  async manifestText(): Promise<string> {
    const entries = await this.listEntries();
    if (entries.length === 0) return '';
    const lines = ['## Available skills'];
    for (const e of entries) {
      const scopeTag = e.scope.length > 0 ? ` — ${e.scope.slice(0, 3).join(', ')}` : '';
      lines.push(`- **${e.name}**${scopeTag}`);
      lines.push(`  Use when: ${e.trigger}`);
    }
    return lines.join('\n');
  }

  async listEntries(): Promise<SkillEntry[]> {
    if (this.entriesCache) return this.entriesCache;
    const skills = await this.list();
    const entries: SkillEntry[] = [];
    for (const s of skills) {
      // Parse trigger/scope from the description that list() already parsed —
      // no need to re-read the file; s.description === fm.description.
      const { trigger, scope } = parseDescriptionFromText(s.description ?? '');
      entries.push({ name: s.name, trigger, scope, source: s.source, path: s.path });
    }
    this.entriesCache = entries;
    return entries;
  }

  invalidateCache(): void {
    this.cache = undefined;
    this.entriesCache = undefined;
    this.bodyCache.clear();
  }

  async readBody(name: string): Promise<string> {
    const key = name.toLowerCase();
    const cached = this.bodyCache.get(key);
    if (cached !== undefined) return cached;
    const m = await this.find(name);
    if (!m) throw new Error(`Skill "${name}" not found`);
    const body = await fs.readFile(m.path, 'utf8');
    this.bodyCache.set(key, body);
    return body;
  }

  async readSaveBody(name: string): Promise<string> {
    const key = `save:${name.toLowerCase()}`;
    const cached = this.bodyCache.get(key);
    if (cached !== undefined) return cached;
    const m = await this.find(name);
    if (!m) throw new Error(`Skill "${name}" not found`);
    // Try SKILL.save.md in the same directory as SKILL.md
    const savePath = path.join(path.dirname(m.path), 'SKILL.save.md');
    let result: string;
    try {
      result = await fs.readFile(savePath, 'utf8');
    } catch {
      // No hand-crafted save variant — auto-compact the full body
      const full = await fs.readFile(m.path, 'utf8');
      const body = stripFrontmatter(full);
      const compact = compactSkillBody(body);
      if (compact) {
        result = `## Overview\n\n${compact}`;
      } else {
        // Fallback: return first 300 chars of full body
        result = body.trim().slice(0, 300);
      }
    }
    this.bodyCache.set(key, result);
    return result;
  }
}

interface Frontmatter {
  name?: string | undefined;
  description?: string | undefined;
  version?: string | undefined;
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
 * Parse skill description into:
 * - trigger: extracted "Use when..." sentence (first sentence of description)
 * - scope: comma-separated items from first line's parenthetical or file-ext list
 */
/**
 * Extract trigger and scope from a skill's description text.
 * Used by listEntries() when the description has already been parsed from frontmatter.
 */
function parseDescriptionFromText(desc: string): { trigger: string; scope: string[] } {
  // Extract first sentence as trigger
  const firstSentenceEnd = desc.indexOf('. ');
  const trigger =
    firstSentenceEnd !== -1
      ? desc.slice(0, firstSentenceEnd + 1).trim()
      : (desc.trim().split('\n')[0] ?? '');

  // Extract scope from parenthetical: "Covers X, Y, and Z" or "for A, B, C"
  const scope: string[] = [];
  const coversMatch = /(?:covers|for|including)\s+([^.]+)/i.exec(desc);
  if (coversMatch) {
    // NB: parenthesize the `?? ''` — without it, `??` binds looser than the
    // method chain, so `items` would be the raw match string and `...items`
    // would spread it into individual characters.
    const items = (coversMatch[1] ?? '')
      .replace(/[·•]/g, ',')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    scope.push(...items);
  }

  return { trigger, scope };
}


