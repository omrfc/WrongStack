import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

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
      await fh.sync();
      await fh.close();
    } catch {
      // fsync best-effort
    }
    // Now safely read mode from target (if it exists) and apply to tmp before rename
    let mode: number | undefined;
    try {
      const stat = await fs.stat(targetPath);
      mode = stat.mode & 0o777;
    } catch {
      // target may not exist yet; mode stays undefined
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
