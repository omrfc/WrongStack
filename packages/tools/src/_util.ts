import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as Core from '@wrongstack/core';
import type { Context } from '@wrongstack/core';
/** Detected package manager for a project directory. */
export type PackageManager = 'pnpm' | 'yarn' | 'npm';

/**
 * Detect the project's package manager by inspecting lockfiles in `cwd`.
 * Order: pnpm → yarn → npm (default). Missing or unreadable directories fall
 * back to `npm` rather than throwing, so a `safeResolve`-checked cwd that
 * happens to be empty never aborts the tool.
 */
export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(`${cwd}/pnpm-lock.yaml`);
    return 'pnpm';
  } catch {
    /* not pnpm */
  }
  try {
    await stat(`${cwd}/yarn.lock`);
    return 'yarn';
  } catch {
    /* not yarn */
  }
  return 'npm';
}

export function resolvePath(input: string, ctx: Context): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(ctx.workingDir ?? ctx.cwd, input);
}

export function ensureInsideRoot(absPath: string, ctx: Context): string {
  const target = path.resolve(absPath);
  // Unrestricted filesystem access: skip the project-root containment check.
  if (ctx.allowOutsideProjectRoot) return target;
  const root = path.resolve(ctx.projectRoot);
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
  // Unrestricted filesystem access: no symlink-escape check to perform.
  // `=== false` (not falsy) so a ctx lacking the field stays confined.
  if (ctx.restrictFsToRoot === false || ctx.allowOutsideProjectRoot) return;
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

// ─── Command-output normalization (token-saving) ────────────────────────────
//
// Raw process output is full of tokens the model gains nothing from: ANSI
// escapes, carriage-return progress spam, runs of identical warning lines, and
// huge tails of build noise. These helpers strip that noise before the output
// reaches the LLM. They are scoped to COMMAND tools (bash/git/exec and the
// _spawn-stream consumers) — never applied to structured/code outputs.

/** Unified byte cap for all command tool output fed to the model. */
export const COMMAND_OUTPUT_MAX_BYTES = 32_768;

/** Runs of >= this many identical consecutive lines are collapsed. */
const REPEAT_RUN_THRESHOLD = 3;

/**
 * Collapse carriage-return overwrites the way a terminal would: `\r\n` becomes
 * `\n`, and a bare `\r` (progress redraw) keeps only the text after the LAST
 * `\r` on its physical line. Without this, a single progress bar that redraws
 * 200 times explodes into 200 lines.
 */
export function collapseCarriageReturns(text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  if (!lf.includes('\r')) return lf;
  return lf
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
}

/**
 * Collapse a run of `minRun`+ identical consecutive lines into the line once
 * plus a marker. Consecutive-only — it never reorders or dedups non-adjacent
 * lines, so diffs/source stay intact.
 */
export function collapseConsecutiveDuplicates(text: string, minRun = REPEAT_RUN_THRESHOLD): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= minRun) {
      out.push(lines[i]!, `… ⟨repeated ${run}×⟩`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join('\n');
}

/** Largest prefix of `s` whose UTF-8 byte length is <= `maxBytes`. */
function takeHeadBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  /* v8 ignore next -- only caller (truncateHeadTail) passes a budget smaller than s; defensive. */
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** Largest suffix of `s` whose UTF-8 byte length is <= `maxBytes`. */
function takeTailBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  /* v8 ignore next -- only caller (truncateHeadTail) passes a budget smaller than s; defensive. */
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(s.length - mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(s.length - lo);
}

/**
 * Truncate to `maxBytes` keeping BOTH ends — the head (what ran / early context)
 * and the tail (errors and summaries usually land last), biased ~45/55 toward
 * the tail. The result never exceeds `maxBytes`.
 */
export function truncateHeadTail(s: string, maxBytes: number): string {
  const total = Buffer.byteLength(s, 'utf8');
  if (total <= maxBytes) return s;
  // Reserve a fixed allowance for the marker so the final string can't exceed
  // the cap even though the dropped-byte count's digit width varies.
  const MARKER_RESERVE = 64;
  const avail = Math.max(0, maxBytes - MARKER_RESERVE);
  const headBudget = Math.floor(avail * 0.45);
  const head = takeHeadBytes(s, headBudget);
  const tail = takeTailBytes(s, avail - Buffer.byteLength(head, 'utf8'));
  const kept = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  return `${head}\n…[truncated ${total - kept} bytes]…\n${tail}`;
}

/**
 * Full token-saving pipeline for command tool output: strip ANSI → collapse
 * carriage-return progress → trim trailing whitespace → collapse identical
 * consecutive lines → squeeze blank-line runs → head+tail truncate to the cap.
 */
export function normalizeCommandOutput(
  raw: string,
  opts: { maxBytes?: number | undefined } = {},
): string {
  if (!raw) return raw;
  let text = Core.stripAnsi(raw);
  text = collapseCarriageReturns(text);
  text = text.replace(/[ \t]+$/gm, ''); // trailing whitespace per line
  text = collapseConsecutiveDuplicates(text);
  text = text.replace(/\n{3,}/g, '\n\n'); // >=2 blank lines → 1
  return truncateHeadTail(text, opts.maxBytes ?? COMMAND_OUTPUT_MAX_BYTES);
}
