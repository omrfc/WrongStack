import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';

export function resolvePath(input: string, ctx: Context): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(ctx.cwd, input);
}

export function ensureInsideRoot(absPath: string, ctx: Context): string {
  const root = path.resolve(ctx.projectRoot);
  const target = path.resolve(absPath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${absPath}" is outside project root "${root}"`);
  }
  return target;
}

export function safeResolve(input: string, ctx: Context): string {
  return ensureInsideRoot(resolvePath(input, ctx), ctx);
}

/**
 * Defense against in-root→out-of-root symlink escape (CWE-59). `safeResolve`
 * only does a syntactic `../` check, so a symlink that lives *inside* the
 * project root but points outside still passes it. This resolves the path
 * through `fs.realpath` and re-verifies containment against the realpath of
 * the project root (comparing like-for-like, since the root itself may be a
 * symlink — macOS `/var`→`/private/var`, Windows 8.3 short names). For a path
 * that does not exist yet (e.g. a `write` to a new file) the nearest existing
 * ancestor directory is checked instead. Throws if the real target escapes.
 *
 * Mirrors the per-file guard already used in `replace.ts`/`grep.ts`; applied
 * to single-file `read`/`edit`/`write` it throws (rather than skips) because
 * the caller named exactly one file.
 */
export async function assertRealInsideRoot(absPath: string, ctx: Context): Promise<void> {
  const realRoot = await fsp.realpath(ctx.projectRoot).catch(() => path.resolve(ctx.projectRoot));
  let probe = absPath;
  for (;;) {
    let real: string;
    try {
      real = await fsp.realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) return; // reached fs root without escaping
        probe = parent;
        continue;
      }
      throw err;
    }
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `Path "${absPath}" resolves through a symlink outside project root "${realRoot}"`,
      );
    }
    return;
  }
}

/** `safeResolve` + symlink realpath containment check. Async. */
export async function safeResolveReal(input: string, ctx: Context): Promise<string> {
  const abs = safeResolve(input, ctx);
  await assertRealInsideRoot(abs, ctx);
  return abs;
}

export function truncateMiddle(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const half = Math.floor(max / 2);
  return (
    s.slice(0, half) +
    `\n…[truncated ${Buffer.byteLength(s, 'utf8') - max} bytes from middle]…\n` +
    s.slice(-half)
  );
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
