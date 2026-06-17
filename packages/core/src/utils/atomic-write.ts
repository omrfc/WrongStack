import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface AtomicWriteOptions {
  mode?: number | undefined;
  encoding?: BufferEncoding | undefined;
}

export interface FileLockOptions {
  timeoutMs?: number | undefined;
  staleMs?: number | undefined;
}

export async function atomicWrite(
  targetPath: string,
  content: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);

  // Write content to tmp first; 'wx' ensures exclusive creation (fails if
  // tmp already exists — extremely unlikely with 6-byte random suffix).
  try {
    if (typeof content === 'string') {
      await fs.writeFile(tmp, content, { flag: 'wx', encoding: opts.encoding ?? 'utf8' });
    } else {
      await fs.writeFile(tmp, content, { flag: 'wx' });
    }
    try {
      const fh = await fs.open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // fsync best-effort
    }
    // Now safely read mode from target (if it exists) and apply to tmp before rename.
    // Prefer opts.mode for new files; for existing files preserve their mode.
    let mode: number | undefined;
    try {
      const stat = await fs.stat(targetPath);
      mode = stat.mode & 0o777;
    } catch {
      mode = opts.mode;
    }
    if (mode !== undefined) {
      await fs.chmod(tmp, mode);
    }
    await renameWithRetry(tmp, targetPath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, `.${path.basename(targetPath)}.lock`);
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const staleMs = opts.staleMs ?? 30_000;
  const started = Date.now();
  let handle: fs.FileHandle | undefined;

  for (;;) {
    try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}:${Date.now()}`);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT means the directory was deleted (e.g. by concurrent cleanup).
      // Recreate it and retry acquiring the lock.
      if (code === 'ENOENT') {
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      if (code !== 'EEXIST') throw err;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${targetPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await handle?.close();
    } catch {
      // ignore
    }
    try {
      await fs.unlink(lockPath);
    } catch {
      // ignore
    }
  }
}

// On Windows, fs.rename over an existing file can fail with EPERM/EBUSY/EACCES
// when antivirus, file indexers, editor file watchers, or a concurrent writer
// briefly hold a handle on the destination. These are transient — retry with a
// short backoff before giving up. POSIX renames are atomic and won't hit this.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  if (process.platform !== 'win32') {
    await fs.rename(from, to);
    return;
  }
  const delays = [10, 25, 60, 120, 250];
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || i === delays.length) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
  }
  throw lastErr;
}
