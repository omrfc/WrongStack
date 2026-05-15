import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface AtomicWriteOptions {
  mode?: number;
  encoding?: BufferEncoding;
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
    await fs.rename(tmp, targetPath);
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
