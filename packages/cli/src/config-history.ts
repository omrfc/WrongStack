import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { atomicWrite, FsError, ERROR_CODES } from '@wrongstack/core';
import { isSecretField } from '@wrongstack/core/security';

// ── UID ownership ──────────────────────────────────────────────────────────

type UidFn = () => string | number | undefined;
const defaultUidFn: UidFn = () => os.userInfo().uid;

async function getFileUid(filePath: string): Promise<string | number | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.uid;
  } catch {
    return undefined;
  }
}

/**
 * Verify the calling process owns config.json before allowing a write operation.
 * Guards against one user on a shared multi-user system overwriting another's config.
 *
 * On Windows, .uid is always undefined on the UserInfo object, and the NT ACL
 * model already restricts writes — so we skip the check on win32.
 * On Unix, we compare the process euid against the file's uid.
 * If config.json doesn't exist yet, we allow the write (first-time setup).
 */
async function checkConfigOwnership(
  homeFn: HomeDirFn,
  uidFn: UidFn = defaultUidFn,
): Promise<boolean> {
  if (os.platform() === 'win32') return true; // ACLs handle this on Windows

  const cfg = configPath(homeFn);
  const fileUid = await getFileUid(cfg);
  if (fileUid === undefined) return true; // file doesn't exist yet — allow

  const callerUid = uidFn();
  if (callerUid === undefined) return true; // can't determine — allow, don't block

  return fileUid === callerUid;
}

// ── Protected files/directories ────────────────────────────────────
// These are NEVER touched by any operation in this module.
// Guards against bugs (glob patterns, typos, race conditions)
// accidentally deleting critical user data.
const PROTECTED_BASENAMES = new Set([
  'config.json',
  '.key',
  'index.json',
]);

// Top-level directories that should never be deleted even if a prune
// pattern accidentally widens. These are absolute directory names
// relative to the .wrongstack root.

/**
 * Guard: throw if `filename` is a protected file or lives inside a protected
 * directory. Used before any unlink / rm call to make accidentally deleting
 * critical files impossible.
 */
function assertSafeToDelete(filename: string, parentDir: string): void {
  // 1. Exact-match protected files
  if (PROTECTED_BASENAMES.has(filename)) {
    throw new Error(`Refusing to delete protected file: ${filename}`);
  }
  // 2. No path traversal
  if (filename !== path.basename(filename)) {
    throw new Error(`Refusing to delete path with traversal: ${filename}`);
  }
  // 3. Validate it's a timestamped config backup (config.json.{ts}.bak)
  //    before we ever consider deleting it.
  if (!filename.startsWith('config.json.') || !filename.endsWith('.bak')) {
    // Unknown files — be conservative, refuse
    throw new Error(`Refusing to delete unknown file: ${filename}`);
  }
  // 4. Check parent is the .wrongstack root and the target is not a dir
  const resolvedParent = path.resolve(parentDir);
  if (!resolvedParent.endsWith('.wrongstack')) {
    throw new Error(`Unexpected parent directory for bak prune: ${resolvedParent}`);
  }
}

/**
 * Safely delete a file only if it passes safety checks.
 * Never throws — errors are swallowed (best-effort).
 */
async function safeDelete(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  try {
    assertSafeToDelete(filename, dir);
    await fs.unlink(filePath);
  } catch (err) {
    // Log but don't crash — safety check violations are logged for debugging
    if (err instanceof Error && err.message.startsWith('Refusing')) {
      process.stderr.write(`[config-history] SAFETY: ${err.message}\n`);
    }
    // Best-effort — ignore other errors (file doesn't exist, etc.)
  }
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  description: string;
  snapshotMasked: Record<string, unknown>;
  diffSummary: string;
}

interface HistoryIndex {
  version: 1;
  entries: Array<{ id: string; timestamp: string; description: string }>;
}

function maskConfigSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
  if (typeof cfg !== 'object' || cfg === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (isSecretField(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = maskConfigSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function diffSummary(oldCfg: Record<string, unknown>, newCfg: Record<string, unknown>): string {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(oldCfg), ...Object.keys(newCfg)]);
  for (const k of allKeys) {
    const o = JSON.stringify(oldCfg[k]);
    const n = JSON.stringify(newCfg[k]);
    if (o !== n) {
      if (isSecretField(k)) {
        changes.push(`${k}: [CHANGED]`);
      } else if (typeof newCfg[k] !== 'object') {
        changes.push(`${k}: ${oldCfg[k] ?? '(unset)'} → ${newCfg[k]}`);
      } else {
        changes.push(`${k}: [CHANGED]`);
      }
    }
  }
  return changes.length > 0 ? changes.slice(0, 5).join(', ') : 'no changes';
}

type HomeDirFn = () => string;
const defaultHomeDir: HomeDirFn = () => os.homedir();

function historyDir(homeFn: HomeDirFn = defaultHomeDir): string {
  return path.join(homeFn(), '.wrongstack', 'config.history', 'entries');
}

function historyIndexPath(homeFn: HomeDirFn = defaultHomeDir): string {
  return path.join(homeFn(), '.wrongstack', 'config.history', 'index.json');
}

// NOTE: config.json is the canonical path (defined in wstack-paths.ts).
// backupCurrent() and restore*() all operate on config.json.
function configPath(homeFn: HomeDirFn = defaultHomeDir): string {
  return path.join(homeFn(), '.wrongstack', 'config.json');
}

function backupLastPath(homeFn: HomeDirFn = defaultHomeDir): string {
  return path.join(homeFn(), '.wrongstack', 'config.json.last');
}

function entryId(ts: string): string {
  return ts.replace(/[:.]/g, '-').slice(0, 19);
}

async function ensureHistoryDir(homeFn: HomeDirFn = defaultHomeDir): Promise<void> {
  try {
    await fs.mkdir(historyDir(homeFn), { recursive: true });
  } catch (err) {
    throw new FsError({
      message: err instanceof Error ? err.message : String(err),
      code: ERROR_CODES.FS_MKDIR_FAILED,
      path: historyDir(homeFn),
      cause: err,
    });
  }
}

async function readIndex(homeFn: HomeDirFn = defaultHomeDir): Promise<HistoryIndex> {
  try {
    const raw = await fs.readFile(historyIndexPath(homeFn), 'utf8');
    return JSON.parse(raw) as HistoryIndex;
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeIndex(idx: HistoryIndex, homeFn: HomeDirFn = defaultHomeDir): Promise<void> {
  await ensureHistoryDir(homeFn);
  // atomicWrite: torn write here would wipe the entire config-history
  // index, hiding the user's prior backups behind a "no history" UI.
  try {
    await atomicWrite(historyIndexPath(homeFn), JSON.stringify(idx, null, 2));
  } catch (err) {
    throw new FsError({
      message: err instanceof Error ? err.message : String(err),
      code: ERROR_CODES.FS_ATOMIC_WRITE_FAILED,
      path: historyIndexPath(homeFn),
      cause: err,
    });
  }
}

/**
 * Backup current config.json → config.json.last and timestamped .bak files.
 * Safe to call even if config.json doesn't exist. Never throws.
 *
 * IMPORTANT: config.json and .key are never deleted by this function.
 * Only config.json.*.bak timestamped snapshots are pruned.
 */
export async function backupCurrent(homeFn: HomeDirFn = defaultHomeDir): Promise<void> {
  const cfg = configPath(homeFn);
  const last = backupLastPath(homeFn);
  const ts = Date.now();

  // Read existing config content for .last backup
  let content: string | undefined;
  try {
    content = await fs.readFile(cfg, 'utf8');
  } catch {
    // May not exist yet — that's fine, we just skip the backup
  }

  if (content !== undefined) {
    try {
      await atomicWrite(last, content);
    } catch {
      // Best-effort — .last backup is nice to have but not critical
    }
  }

  // Create timestamped snapshot
  if (content !== undefined) {
    try {
      const bakPath = path.join(homeFn(), '.wrongstack', `config.json.${ts}.bak`);
      await atomicWrite(bakPath, content);
    } catch {
      // Best-effort
    }
  }

  // Prune old .bak files — keep last 10
  try {
    const dir = path.join(homeFn(), '.wrongstack');
    const files = await fs.readdir(dir);
    const baks = files
      .filter((f) => f.startsWith('config.json.') && f.endsWith('.bak'))
      .sort()
      .reverse();
    for (const f of baks.slice(10)) {
      await safeDelete(path.join(dir, f));
    }
  } catch {
    // Best-effort
  }
}

/**
 * Append a history entry for a config change.
 */
export async function appendHistory(
  oldCfg: Record<string, unknown>,
  newCfg: Record<string, unknown>,
  description: string,
  homeFn: HomeDirFn = defaultHomeDir,
): Promise<string> {
  const timestamp = new Date().toISOString();
  const id = entryId(timestamp);

  await ensureHistoryDir(homeFn);

  const entry: HistoryEntry = {
    id,
    timestamp,
    description,
    snapshotMasked: maskConfigSecrets(newCfg) as Record<string, unknown>,
    diffSummary: diffSummary(oldCfg, newCfg),
  };

  try {
    await fs.writeFile(
      path.join(historyDir(homeFn), `${id}.json`),
      JSON.stringify(entry, null, 2),
      'utf8',
    );
  } catch (err) {
    throw new FsError({
      message: err instanceof Error ? err.message : String(err),
      code: ERROR_CODES.FS_WRITE_FAILED,
      path: path.join(historyDir(homeFn), `${id}.json`),
      cause: err,
    });
  }

  const idx = await readIndex(homeFn);
  idx.entries.unshift({ id, timestamp, description });
  await writeIndex(idx, homeFn);

  return id;
}

/**
 * List all history entries (newest first).
 */
export async function listHistory(homeFn: HomeDirFn = defaultHomeDir): Promise<HistoryIndex['entries']> {
  const idx = await readIndex(homeFn);
  return idx.entries;
}

/**
 * Get a specific history entry by ID.
 */
export async function getHistoryEntry(id: string, homeFn: HomeDirFn = defaultHomeDir): Promise<HistoryEntry | null> {
  try {
    const raw = await fs.readFile(path.join(historyDir(homeFn), `${id}.json`), 'utf8');
    return JSON.parse(raw) as HistoryEntry;
  } catch {
    return null;
  }
}

/**
 * Restore config.json to a given history entry's snapshot.
 */
export async function restoreFromHistory(
  id: string,
  homeFn: HomeDirFn = defaultHomeDir,
): Promise<{ ok: boolean; backupId: string | null; error?: string }> {
  const entry = await getHistoryEntry(id, homeFn);
  if (!entry) return { ok: false, backupId: null, error: 'History entry not found' };

  // Ownership guard — refuse to write config.json if the calling process
  // does not own the file. Prevents one user on a multi-user system from
  // overwriting another user's config via a shared wrongstack install.
  if (!(await checkConfigOwnership(homeFn))) {
    return { ok: false, backupId: null, error: 'Operation denied: config file is not owned by current user' };
  }

  await backupCurrent(homeFn);

  let oldCfg: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath(homeFn), 'utf8');
    oldCfg = JSON.parse(raw);
  } catch {
    // No config to restore from
  }

  try {
    await atomicWrite(configPath(homeFn), JSON.stringify(entry.snapshotMasked, null, 2));
  } catch (err) {
    return { ok: false, backupId: null, error: String(err) };
  }

  const backupId = await appendHistory(
    oldCfg,
    entry.snapshotMasked as Record<string, unknown>,
    `Restored from history ${id}`,
    homeFn,
  );

  return { ok: true, backupId };
}

/**
 * Restore config.json to the .last backup.
 */
export async function restoreLast(homeFn: HomeDirFn = defaultHomeDir): Promise<{ ok: boolean; error?: string }> {
  const last = backupLastPath(homeFn);
  const cfg = configPath(homeFn);

  let oldCfg: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(cfg, 'utf8');
    oldCfg = JSON.parse(raw);
  } catch {
    // Ignore
  }

  let lastCfg: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(last, 'utf8');
    lastCfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'No prior backup found' };
  }

  // Ownership guard — refuse to write config.json if the calling process
  // does not own the file. Prevents one user on a multi-user system from
  // overwriting another user's config via a shared wrongstack install.
  if (!(await checkConfigOwnership(homeFn))) {
    return { ok: false, error: 'Operation denied: config file is not owned by current user' };
  }

  await backupCurrent(homeFn);

  try {
    await atomicWrite(cfg, JSON.stringify(lastCfg, null, 2));
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  await appendHistory(oldCfg, lastCfg, 'Restored from config.json.last', homeFn);

  return { ok: true };
}