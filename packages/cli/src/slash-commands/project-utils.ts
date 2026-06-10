import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Types ──────────────────────────────────────────────────────────────

export interface ProjectEntry {
  /** User-friendly name (defaults to dirname, can be renamed). */
  name: string;
  /** Absolute path to the project root. */
  root: string;
  /** Stable unique slug (dirname-hash) for per-project data storage. */
  slug: string;
  /** ISO timestamp of last use. */
  lastSeen?: string | undefined;
  /** ISO timestamp of when the project was first registered. */
  createdAt?: string | undefined;
}

export interface ProjectsManifest {
  projects: ProjectEntry[];
}

// ── Path resolution ───────────────────────────────────────────────────

function projectsJsonPath(globalConfigPath?: string | undefined): string {
  const base = globalConfigPath
    ? path.dirname(globalConfigPath)
    : path.join(os.homedir(), '.wrongstack');
  return path.join(base, 'projects.json');
}

function projectsDataDir(globalConfigPath?: string | undefined): string {
  const base = globalConfigPath
    ? path.dirname(globalConfigPath)
    : path.join(os.homedir(), '.wrongstack');
  return path.join(base, 'projects');
}

// ── Read / Write manifest ─────────────────────────────────────────────

export async function loadManifest(globalConfigPath?: string | undefined): Promise<ProjectsManifest> {
  const file = projectsJsonPath(globalConfigPath);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as ProjectsManifest;
    return { projects: parsed.projects ?? [] };
  } catch {
    return { projects: [] };
  }
}

export async function saveManifest(manifest: ProjectsManifest, globalConfigPath?: string | undefined): Promise<void> {
  const file = projectsJsonPath(globalConfigPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Generate a unique slug from a project root path.
 */
export function generateSlug(root: string): string {
  const base = path.basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const hash = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

/**
 * Find a project entry by slug, name, or root (partial match).
 */
export function findProject(manifest: ProjectsManifest, query: string): ProjectEntry | undefined {
  const lower = query.toLowerCase();
  // Exact slug match first
  let found = manifest.projects.find((p) => p.slug === lower);
  if (found) return found;
  // Name match
  found = manifest.projects.find((p) => p.name.toLowerCase() === lower);
  if (found) return found;
  // Root ends-with match
  found = manifest.projects.find((p) => p.root.toLowerCase().endsWith(lower));
  if (found) return found;
  // Root contains match
  found = manifest.projects.find((p) => p.root.toLowerCase().includes(lower));
  return found;
}

/**
 * Ensure the per-project data directory exists under ~/.wrongstack/projects/<slug>/.
 */
export async function ensureProjectDataDir(slug: string, globalConfigPath?: string | undefined): Promise<string> {
  const dir = path.join(projectsDataDir(globalConfigPath), slug);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
