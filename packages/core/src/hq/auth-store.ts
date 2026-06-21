/**
 * HQ auth-store — persistent `auth.json` for the HQ command center.
 *
 * Phase 4 scope:
 * - Operator-configured redaction policy override (applied server-side
 *   even when a publisher claims rawContent:true).
 * - Browser tokens (Phase 3) + client tokens (Phase 4). Separate lists so
 *   a browser-only token cannot be replayed on /ws/client and vice versa.
 * - Live reload hook: callers can `watchHqAuthFile()` to re-read on change.
 *
 * Storage layout (under the HQ data directory, default `~/.wrongstack/hq/`):
 *   <dataDir>/auth.json   — this file (atomic write, mode 0o600)
 *   <dataDir>/events.jsonl — reserved for future persistent event log
 *   <dataDir>/snapshot.json — reserved for future persisted snapshot
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
import * as syncFs from 'node:fs';
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

/**
 * A generic HQ-issued token. Used for both browser tokens (validated on
 * `/ws/browser`) and client tokens (validated on `/ws/client`). The two
 * are stored in separate lists so a browser-only token cannot be replayed
 * against the client channel and vice versa.
 */
export interface HqToken {
  id: string;
  token: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * Alias kept for backward-compat with Phase 3 callers/tests. New code
 * should prefer `HqToken`.
 */
export type HqBrowserToken = HqToken;

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
  /** Browser tokens — validated on `/ws/browser` upgrades (Phase 3). */
  browserTokens?: HqToken[];
  /** Client tokens — validated on `/ws/client` upgrades (Phase 4). */
  clientTokens?: HqToken[];
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

export interface EnsureHqFirstRunAuthResult {
  authFile: HqAuthFile;
  created: boolean;
  browserToken?: HqToken;
  clientToken?: HqToken;
}

/**
 * Ensure a brand-new HQ data directory has the auth required for safe
 * first-run operation. Only a missing auth.json is bootstrapped; an existing
 * file, including one with empty token arrays, is treated as operator intent.
 */
export async function ensureHqFirstRunAuthFile(
  dataDir: string,
  opts: { warn?: (msg: string) => void } = {},
): Promise<EnsureHqFirstRunAuthResult> {
  const file = hqAuthFilePath(dataDir);
  try {
    await fs.access(file);
    return { authFile: await readHqAuthFile(dataDir, opts), created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      opts.warn?.(`HQ auth file access failed at ${file}: ${(err as Error).message}`);
      return { authFile: await readHqAuthFile(dataDir, opts), created: false };
    }
  }

  const browserToken = mintHqToken('first-run browser');
  const clientToken = mintHqToken('first-run client');
  const authFile: HqAuthFile = {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [browserToken],
    clientTokens: [clientToken],
  };
  await writeHqAuthFile(dataDir, authFile);
  return { authFile: await readHqAuthFile(dataDir, opts), created: true, browserToken, clientToken };
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
 * Mint a fresh token. Used for both browser and client tokens; the caller
 * decides which list to append to.
 */
export function mintHqToken(label?: string): HqToken {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    token: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    ...(label ? { label } : {}),
    createdAt: now,
  };
}

/**
 * Backward-compat alias for `mintHqToken`. Phase 3 callers/tests use this.
 */
export const mintHqBrowserToken = mintHqToken;

/**
 * Watch `auth.json` for changes and invoke `onChange` with the freshly-read
 * file. Returns a `close()` function that stops watching.
 *
 * The watcher debounces events (default 200ms) because most editors do a
 * tmp+rename dance that emits multiple events. On any read failure (file
 * deleted, corrupt, etc.) the `warn` callback is invoked with the same
 * semantics as `readHqAuthFile`; the watcher stays active so a future
 * valid write re-triggers the callback.
 *
 * Notes:
 * - `fs.watch` is best-effort across platforms. On some network
 *   filesystems events may not fire; the operator must restart the server
 *   to pick up changes in that case.
 * - The watcher polls the parent directory (not the file itself) so that
 *   atomic rename events surface reliably.
 */
export function watchHqAuthFile(
  dataDir: string,
  onChange: (file: HqAuthFile) => void,
  opts: { warn?: (msg: string) => void; debounceMs?: number } = {},
): { close: () => void } {
  const file = hqAuthFilePath(dataDir);
  const debounceMs = opts.debounceMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  let watcher: syncFs.FSWatcher;
  try {
    // Watch the directory (not the file) so atomic-rename events surface
    // reliably. `fs.watch` is best-effort across platforms — on some
    // network filesystems events may not fire; the operator must restart
    // the server in that case.
    watcher = syncFs.watch(path.dirname(file), { recursive: false });
  } catch (err) {
    opts.warn?.(`HQ auth watcher could not start: ${(err as Error).message}`);
    return { close: () => {} };
  }

  const trigger = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const readOpts = opts.warn ? { warn: opts.warn } : {};
      void readHqAuthFile(dataDir, readOpts).then(
        (next) => {
          if (!closed) onChange(next);
        },
        () => {
          // readHqAuthFile never throws for routine I/O — this is a
          // belt-and-braces guard.
        },
      );
    }, debounceMs);
  };

  watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
    const name = typeof filename === 'string' ? filename : '';
    // Only react to events that touch auth.json (rename, change).
    if (eventType === 'rename' || eventType === 'change') {
      if (!name || name === 'auth.json' || name === path.basename(file)) {
        trigger();
      }
    }
  });

  watcher.on('error', (err: Error) => {
    opts.warn?.(`HQ auth watcher error: ${err.message}`);
  });

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
