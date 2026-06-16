/**
 * FileServer — answers `fs/read_text_file` and `fs/write_text_file`
 * from an ACP agent, scoped to a single project root.
 *
 * Per the spec, all file paths in ACP MUST be absolute. We additionally
 * require them to resolve under `projectRoot` after normalisation;
 * anything else is rejected with a JSON-RPC error so the agent can't
 * use us to read `/etc/passwd` or write to `~/.ssh/`.
 *
 * The server itself is transport-agnostic: the caller (ACPSession)
 * routes incoming fs/* requests to `handle()` and sends the result
 * back. Keeping the routing out of this class lets the file logic be
 * unit-tested in isolation.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface FileServerOptions {
  /** Absolute path; only files under this root are accessible. */
  projectRoot: string;
  /** Per-call timeout, default 30s. */
  timeoutMs?: number;
}

export interface ReadFileParams {
  sessionId: string;
  path: string;
}

export interface WriteFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export type FsErrorCode = 'ENOENT' | 'EACCES' | 'OUTSIDE_ROOT' | 'TIMEOUT' | 'INVALID_PATH';

/**
 * Thrown for protocol-level rejections (path outside root, etc.).
 * The session converts these into JSON-RPC error responses.
 */
export class FsError extends Error {
  readonly code: FsErrorCode;
  readonly path: string;
  constructor(code: FsErrorCode, path: string, message: string) {
    super(message);
    this.name = 'FsError';
    this.code = code;
    this.path = path;
  }
}

export class FileServer {
  private readonly root: string;
  private readonly timeoutMs: number;

  constructor(opts: FileServerOptions) {
    this.root = path.resolve(opts.projectRoot);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Read a text file. Returns the content as a string. */
  async readTextFile(params: ReadFileParams): Promise<{ content: string }> {
    const safe = this.resolveInside(params.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const content = await fsp.readFile(safe, {
        encoding: 'utf8',
        signal: controller.signal,
      });
      return { content };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new FsError('TIMEOUT', safe, `readTextFile timed out after ${this.timeoutMs}ms`);
      }
      throw mapFsError(err, safe);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Write a text file. Atomic via write-then-rename. */
  async writeTextFile(params: WriteFileParams): Promise<void> {
    const safe = this.resolveInside(params.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const tmp = `${safe}.${randomHex(4)}.tmp`;
    try {
      await fsp.writeFile(tmp, params.content, {
        encoding: 'utf8',
        signal: controller.signal,
      });
      await fsp.rename(tmp, safe);
    } catch (err) {
      // Best-effort cleanup of the tmp file
      try {
        await fsp.unlink(tmp);
      } catch {
        // tmp didn't exist; ignore
      }
      if (controller.signal.aborted) {
        throw new FsError('TIMEOUT', safe, `writeTextFile timed out after ${this.timeoutMs}ms`);
      }
      throw mapFsError(err, safe);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve a path; throw `FsError('OUTSIDE_ROOT')` if the result is
   * not under the project root. Symlinks are not followed here — we
   * operate on the textual path. A future hardening pass can
   * `fs.realpath` each access to catch symlink escapes.
   */
  private resolveInside(p: string): string {
    if (typeof p !== 'string' || p.length === 0) {
      throw new FsError('INVALID_PATH', p, 'path is empty or not a string');
    }
    if (!path.isAbsolute(p)) {
      throw new FsError('INVALID_PATH', p, 'path must be absolute (ACP requirement)');
    }
    const resolved = path.resolve(p);
    // +path.sep prevents "/project-evil" matching "/project" as a prefix.
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new FsError('OUTSIDE_ROOT', resolved, 'path is outside the project root');
    }
    return resolved;
  }
}

function mapFsError(err: unknown, p: string): FsError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new FsError('ENOENT', p, `no such file: ${p}`);
  if (code === 'EACCES' || code === 'EPERM') {
    return new FsError('EACCES', p, `permission denied: ${p}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new FsError('INVALID_PATH', p, msg);
}

function randomHex(bytes: number): string {
  // Avoid importing node:crypto for a 4-byte hex string — use Math.random
  // with a clear warning-free use case (temp file suffix only).
  let out = '';
  for (let i = 0; i < bytes * 2; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}
