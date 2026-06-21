/**
 * HQ auth-store — persistent `auth.json` for the HQ command center.
 *
 * Phase 2 scope:
 *   - Operator-configured redaction policy override (applied server-side
 *     even when a publisher claims rawContent:true).
 *   - Schema placeholder for browser tokens (issued in Phase 3).
 *
 * Storage layout (under the HQ data directory, default `~/.wrongstack/hq/`):
 *   <dataDir>/auth.json   — this file (atomic write, mode 0o600)
 *   <dataDir>/events.jsonl — reserved for Phase 3 persistent event log
 *   <dataDir>/snapshot.json — reserved for Phase 3 persisted snapshot
 *
 * The file is written atomically (tmp + rename) with mode 0o600 so a
 * shared host cannot read issued tokens or the redaction policy. Reads
 * are lenient: a missing file yields an empty document; a corrupt file
 * yields an empty document plus a warning so the operator can recover.
 *
 * @module hq/auth-store
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWrite } from '../utils/atomic-write.js';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';
import type { HqRedactionPolicy } from './protocol.js';

/** Current auth-file schema version. Bump on breaking shape changes. */
export const HQ_AUTH_FILE_VERSION = 1 as const;

/** Default HQ data directory: `~/.wrongstack/hq` (honors WRONGSTACK_HOME). */
export function defaultHqDataDir(): string {
  return path.join(wstackGlobalRoot(), 'hq');
}

/**
 * Resolve an HQ data directory from an optional override.
 *
 * Resolution order:
 *   1. Explicit `override` (from `--data-dir`) — resolved against
 *      `process.cwd()` if relative.
 *   2. `WRONGSTACK_HQ_DATA_DIR` env var (same resolution rules).
 *   3. `defaultHqDataDir()` — `~/.wrongstack/hq`.
 *
 * The env var exists so tests (and sandboxed runs) can redirect HQ state
 * away from the real user home without threading a CLI flag everywhere.
 */
export function resolveHqDataDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = override ?? env['WRONGSTACK_HQ_DATA_DIR']?.trim();
  if (!raw) return defaultHqDataDir();
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
}

/** An issued browser token. Phase 3 populates this; Phase 2 carries the schema. */
export interface HqBrowserToken {
  id: string;
  token: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** On-disk shape of `<dataDir>/auth.json`. */
export interface HqAuthFile {
  version: typeof HQ_AUTH_FILE_VERSION;
  updatedAt: string;
  /**
   * Operator-configured redaction policy override. When present, the HQ
   * server applies these settings AFTER any publisher-declared policy —
   * i.e. the operator can always tighten, never loosen.
   */
  redactionPolicy?: Partial<HqRedactionPolicy>;
  /** Issued browser tokens. Empty in Phase 2. */
  browserTokens?: HqBrowserToken[];
}

/** An empty auth file — what a brand-new HQ install starts with. */
export function emptyHqAuthFile(): HqAuthFile {
  return {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

/** Path to `auth.json` under the given data directory. */
export function hqAuthFilePath(dataDir: string): string {
  return path.join(dataDir, 'auth.json');
}

/**
 * Read `auth.json` from disk. Returns `emptyHqAuthFile()` when:
 *   - the file does not exist (ENOENT), or
 *   - the file cannot be parsed (the `warn` callback surfaces the error).
 *
 * Never throws for routine I/O — a missing or corrupt auth file should not
 * prevent the HQ server from starting. The operator can recover by editing
 * or deleting the file.
 */
export async function readHqAuthFile(
  dataDir: string,
  opts: { warn?: (msg: string) => void } = {},
): Promise<HqAuthFile> {
  const file = hqAuthFilePath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyHqAuthFile();
    // Non-ENOENT (EACCES, EIO, …) — surface but don't crash startup.
    opts.warn?.(`HQ auth file read failed at ${file}: ${(err as Error).message}`);
    return emptyHqAuthFile();
  }
  try {
    const parsed = JSON.parse(raw) as HqAuthFile;
    if (parsed.version !== HQ_AUTH_FILE_VERSION) {
      opts.warn?.(
        `HQ auth file at ${file} has unsupported version ${String(parsed.version)} (expected ${String(HQ_AUTH_FILE_VERSION)}); ignoring stored policy/tokens.`,
      );
      return emptyHqAuthFile();
    }
    return parsed;
  } catch (err) {
    opts.warn?.(`HQ auth file at ${file} is not valid JSON; ignoring stored policy/tokens: ${(err as Error).message}`);
    return emptyHqAuthFile();
  }
}

/**
 * Write `auth.json` atomically with mode 0o600. Creates the data directory
 * if needed. Throws on I/O failure — callers (CLI commands) should surface
 * the error to the operator.
 */
export async function writeHqAuthFile(dataDir: string, file: HqAuthFile): Promise<void> {
  const target = hqAuthFilePath(dataDir);
  const payload: HqAuthFile = {
    ...file,
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Load → mutate → write. The mutator receives the current file (or an empty
 * one) and returns the next file. Use this for any read-modify-write cycle
 * to avoid clobbering concurrent edits from another CLI invocation.
 *
 * Note: this does NOT take a file lock. HQ auth edits are rare (operator
 * running `wstack --hq-token add` etc.) and the atomic rename protects
 * against torn writes; a race between two concurrent edits would be
 * last-write-wins, which is acceptable for this low-frequency file.
 */
export async function mutateHqAuthFile(
  dataDir: string,
  mutator: (current: HqAuthFile) => HqAuthFile | Promise<HqAuthFile>,
  opts: { warn?: (msg: string) => void } = {},
): Promise<HqAuthFile> {
  const current = await readHqAuthFile(dataDir, opts);
  const next = await mutator(current);
  await writeHqAuthFile(dataDir, next);
  return next;
}

/**
 * Mint a fresh browser token. Phase 2 exposes this so the schema is wired
 * end-to-end; the actual `/api/tokens` route lands in Phase 3 together
 * with cookie/query-param auth on `/ws/browser`.
 */
export function mintHqBrowserToken(label?: string): HqBrowserToken {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    token: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    ...(label ? { label } : {}),
    createdAt: now,
  };
}
