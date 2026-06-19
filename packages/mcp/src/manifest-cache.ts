/**
 * On-disk cache of MCP server tool manifests.
 *
 * Lazy-connect needs to register a server's tools WITHOUT spawning it. That is
 * only possible once we have seen the tool list at least once — so the first
 * successful connect persists the discovered `tools/list` here, and later boots
 * register resolver-backed wrappers straight from this cache.
 *
 * A `configHash` (over the connection-defining fields) is stored alongside the
 * tools so that changing a server's command/args/url/transport invalidates the
 * stale manifest and forces a fresh discovery connect.
 *
 * All operations are best-effort: a read miss or IO error simply means "no
 * cache", which falls back to a normal connect.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MCPTool } from './client.js';

interface ManifestFile {
  configHash: string;
  tools: MCPTool[];
}

/** Stable hash of the fields that define how/where we connect to a server. */
export function manifestConfigHash(cfg: {
  transport: string;
  command?: string | undefined;
  args?: string[] | undefined;
  url?: string | undefined;
}): string {
  const basis = JSON.stringify({
    transport: cfg.transport,
    command: cfg.command ?? null,
    args: cfg.args ?? null,
    url: cfg.url ?? null,
  });
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** Filesystem-safe file name for a server within the manifest cache dir. */
function manifestFile(cacheDir: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(cacheDir, 'mcp-tools', `${safe}.json`);
}

/**
 * Read a server's cached tools. Returns null when there is no cache or when the
 * stored `configHash` no longer matches (server config changed → stale).
 */
export async function readManifest(
  cacheDir: string,
  name: string,
  configHash: string,
): Promise<MCPTool[] | null> {
  try {
    const raw = await fs.readFile(manifestFile(cacheDir, name), 'utf8');
    const parsed = JSON.parse(raw) as ManifestFile;
    if (parsed.configHash !== configHash || !Array.isArray(parsed.tools)) return null;
    return parsed.tools;
  } catch {
    return null;
  }
}

/** Persist a server's discovered tools. Best-effort — IO errors are swallowed. */
export async function writeManifest(
  cacheDir: string,
  name: string,
  configHash: string,
  tools: MCPTool[],
): Promise<void> {
  try {
    const file = manifestFile(cacheDir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const body: ManifestFile = { configHash, tools };
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch {
    // best-effort cache — a write failure just means a cold discovery next boot
  }
}
