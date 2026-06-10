import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { color } from '@wrongstack/core';
import { createRequire } from 'node:module';
import type { Context, SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { loadManifest, saveManifest, findProject, generateSlug, ensureProjectDataDir } from './project-utils.js';
import type { ProjectEntry } from './project-utils.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function fmtLastSeen(iso: string | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── Command builder ──────────────────────────────────────────────────────

export function buildProjectCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'project',
    category: 'Session',
    aliases: ['projects'],
    description: 'Manage known projects — list, add, rename, remove, switch.',
    help: [
      'Usage:',
      '  /project                          List all known projects',
      '  /project add <path> [name]        Register a new project',
      '  /project rename <slug> <name>     Rename a project',
      '  /project remove <slug>            Remove a project from the list',
      '  /project switch <dir>             Spawn wstack in target directory',
      '',
      'Projects are registered in ~/.wrongstack/projects.json.',
      'Each project has a name (user-friendly), root path, and slug.',
      'The slug is auto-generated and used for per-project data storage.',
    ].join('\n'),
    async run(args, ctx) {
      const trimmed = args.trim();
      const lower = trimmed.toLowerCase();

      if (!trimmed || lower === 'ls' || lower === 'list') {
        return listProjectsCommand(opts, ctx);
      }

      if (lower.startsWith('add ') || lower === 'add') {
        const rest = trimmed.slice(lower === 'add' ? 3 : 4).trim();
        const spaceIdx = rest.indexOf(' ');
        const targetPath = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
        const displayName = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : undefined;
        if (!targetPath) return { message: 'Usage: /project add <path> [name]' };
        return addProjectCommand(opts, ctx, targetPath, displayName);
      }

      if (lower.startsWith('rename ') || lower === 'rename') {
        const rest = trimmed.slice(lower === 'rename' ? 6 : 7).trim();
        const spaceIdx = rest.indexOf(' ');
        const slug = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
        const newName = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : undefined;
        if (!slug || !newName) return { message: 'Usage: /project rename <slug> <new-name>' };
        return renameProjectCommand(opts, ctx, slug, newName);
      }

      if (lower.startsWith('remove ') || lower === 'remove') {
        const slug = trimmed.slice(lower === 'remove' ? 6 : 7).trim();
        if (!slug) return { message: 'Usage: /project remove <slug>' };
        return removeProjectCommand(opts, ctx, slug);
      }

      if (lower.startsWith('switch ') || lower === 'switch') {
        const target = trimmed.slice(lower.startsWith('switch ') ? 7 : 6).trim();
        if (!target) return { message: 'Usage: /project switch <directory-path>' };
        return switchProjectCommand(opts, ctx, target);
      }

      return {
        message: [
          `Unknown: "${trimmed}".`,
          'Usage: /project [ls|list|add|rename|remove|switch]',
        ].join('\n'),
      };
    },
  };
}

// ── List ────────────────────────────────────────────────────────────────

async function listProjectsCommand(opts: SlashCommandContext, ctx: Context | undefined) {
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const currentRoot = ctx?.projectRoot;

  if (manifest.projects.length === 0) {
    return {
      message: color.dim('No projects registered. Add one: /project add <path> [name]'),
    };
  }

  // Sort by lastSeen descending
  const sorted = [...manifest.projects].sort((a, b) => {
    if (a.lastSeen && b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
    if (a.lastSeen) return -1;
    if (b.lastSeen) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [`Projects (${sorted.length}) registered in projects.json:`, ''];
  for (const p of sorted) {
    const isCurrent = p.root === currentRoot;
    const marker = isCurrent ? color.green('●') : color.dim('○');
    const name = isCurrent ? color.bold(p.name) : p.name;
    const slug = color.dim(`[${p.slug}]`);
    const last = color.dim(fmtLastSeen(p.lastSeen));
    lines.push(`  ${marker} ${name} ${slug}  ${last}`);
    lines.push(`       ${p.root}`);
    if (isCurrent) {
      lines.push(`       ${color.green('← active session')}`);
    }
    lines.push('');
  }
  lines.push(color.dim('Commands: add <path> [name]  |  rename <slug> <name>  |  remove <slug>  |  switch <dir>'));

  return { message: lines.join('\n') };
}

// ── Add ─────────────────────────────────────────────────────────────────

async function addProjectCommand(opts: SlashCommandContext, ctx: Context | undefined, targetPath: string, displayName?: string) {
  const resolved = path.resolve(ctx?.projectRoot ?? ctx?.cwd ?? process.cwd(), targetPath);

  try {
    await fs.access(resolved);
  } catch {
    return { message: color.red(`Directory not found: ${resolved}`) };
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    return { message: color.red(`Not a directory: ${resolved}`) };
  }

  const manifest = await loadManifest(opts.paths?.globalConfig);
  const existing = manifest.projects.find((p) => p.root === resolved);
  if (existing) {
    return { message: color.yellow(`Project already registered: "${existing.name}" (${existing.slug})`) };
  }

  const name = displayName?.trim() || path.basename(resolved);
  const slug = generateSlug(resolved);
  const now = new Date().toISOString();

  // Ensure the per-project data directory exists
  await ensureProjectDataDir(slug, opts.paths?.globalConfig);

  manifest.projects.push({ name, root: resolved, slug, lastSeen: now, createdAt: now });
  await saveManifest(manifest, opts.paths?.globalConfig);

  return {
    message: [
      '',
      color.green(`  Added project: ${name}`),
      color.dim(`    Root: ${resolved}`),
      color.dim(`    Slug: ${slug}`),
      '',
    ].join('\n'),
  };
}

// ── Rename ──────────────────────────────────────────────────────────────

async function renameProjectCommand(opts: SlashCommandContext, ctx: Context | undefined, slugOrName: string, newName: string) {
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const project = findProject(manifest, slugOrName);
  if (!project) {
    return { message: color.red(`Project not found: "${slugOrName}". Use /project list to see available projects.`) };
  }

  const oldName = project.name;
  project.name = newName;
  await saveManifest(manifest, opts.paths?.globalConfig);

  return { message: color.green(`Renamed: "${oldName}" → "${newName}" (${project.slug})`) };
}

// ── Remove ──────────────────────────────────────────────────────────────

async function removeProjectCommand(opts: SlashCommandContext, ctx: Context | undefined, slugOrName: string) {
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const idx = manifest.projects.findIndex(
    (p) => p.slug === slugOrName || p.name.toLowerCase() === slugOrName.toLowerCase(),
  );
  if (idx === -1) {
    return { message: color.red(`Project not found: "${slugOrName}". Use /project list to see available projects.`) };
  }

  const removed = manifest.projects[idx]!;
  manifest.projects.splice(idx, 1);
  await saveManifest(manifest, opts.paths?.globalConfig);

  return {
    message: color.dim(`Removed: "${removed.name}" (${removed.root}) — data directory kept at ~/.wrongstack/projects/${removed.slug}/`),
  };
}

// ── Switch ──────────────────────────────────────────────────────────────

async function switchProjectCommand(opts: SlashCommandContext, ctx: Context | undefined, target: string) {
  const resolved = path.resolve(ctx?.projectRoot ?? ctx?.cwd ?? process.cwd(), target);

  try {
    await fs.access(resolved);
  } catch {
    return { message: color.red(`Directory not found: ${resolved}`) };
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    return { message: color.red(`Not a directory: ${resolved}`) };
  }

  // Try to resolve the CLI binary
  let cliPath: string;
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@wrongstack/cli/package.json');
    const pkgDir = path.dirname(pkgPath);
    cliPath = path.join(pkgDir, 'dist', 'index.js');
    await fs.access(cliPath);
  } catch {
    cliPath = process.argv[1] ?? '';
    if (!cliPath) {
      return { message: color.red('Could not locate the CLI entry point. Run `wstack` manually in the target directory.') };
    }
  }

  // Update the manifest with the new lastSeen before spawning
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const existing = manifest.projects.find((p) => p.root === resolved);
  if (existing) {
    existing.lastSeen = new Date().toISOString();
  } else {
    // Auto-register if not in manifest
    const name = path.basename(resolved);
    const slug = generateSlug(resolved);
    manifest.projects.push({ name, root: resolved, slug, lastSeen: new Date().toISOString() });
    await ensureProjectDataDir(slug, opts.paths?.globalConfig);
  }
  await saveManifest(manifest, opts.paths?.globalConfig);

  const nodeExe = process.execPath;
  const child = spawn(nodeExe, [cliPath], {
    cwd: resolved,
    stdio: 'inherit',
    detached: false,
    signal: AbortSignal.timeout(30_000),
  });

  child.on('error', (err) => {
    console.error(color.red(`Failed to spawn wstack: ${err.message}`));
  });

  child.unref();

  return {
    message: [
      '',
      color.green(`  Spawning wstack in ${resolved} ...`),
      color.dim('  (current session stays open — Ctrl+C to return)'),
      '',
    ].join('\n'),
  };
}
