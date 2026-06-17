import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';
import { safeResolve } from './_util.js';

interface PatchInput {
  patch: string;
  directory?: string | undefined;
  strip?: number | undefined;
  dry_run?: boolean | undefined;
}

interface PatchOutput {
  applied: number;
  rejected: number;
  files: string[];
  dry_run: boolean;
  message: string;
}

export const patchTool: Tool<PatchInput, PatchOutput> = {
  name: 'patch',
  category: 'Filesystem',
  description:
    'Apply a unified diff (patch) to the project. This is the correct tool when you have a diff that needs to be applied precisely, including handling of rejects.',
  usageHint:
    'Best used when you already have a diff (from generation, external source, or previous step).\n' +
    '- Use `dry_run: true` to see what would happen without modifying files.\n' +
    '- On failure it creates .rej and .orig files for manual review.\n' +
    'Often cleaner than many small `edit` operations for larger changes.',
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'edit',
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Unified diff patch content' },
      directory: { type: 'string', description: 'Root directory for patch (default: cwd)' },
      strip: { type: 'integer', description: 'Strip leading path components (default: 1)' },
      dry_run: { type: 'boolean', description: 'Preview without applying' },
    },
    required: ['patch'],
  },
  async execute(input, ctx, opts) {
    if (!input?.patch) throw new Error('patch: patch content is required');

    const dir = input.directory ? safeResolve(input.directory, ctx) : ctx.cwd;
    // strip=0 lets a diff address absolute paths like /etc/passwd and
    // escape the project root entirely. Force >= 1.
    const strip = Math.max(1, input.strip ?? 1);
    const dryRun = input.dry_run ?? false;

    // Pre-flight: scan diff target paths and reject any that resolve outside
    // the project root. This catches `../../../etc/passwd`-style escapes
    // before we hand the diff to GNU patch.
    const targets = extractDiffTargets(input.patch);
    for (const t of targets) {
      const stripped = stripPathComponents(t, strip);
      if (!stripped) continue;
      const candidate = path.resolve(dir, stripped);
      const rel = path.relative(ctx.projectRoot, candidate);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          applied: 0,
          rejected: 1,
          files: [],
          dry_run: dryRun,
          message: `patch refused: target "${t}" resolves outside project root`,
        };
      }
    }

    // Write the diff into a private 0700 temp directory rather than into
    // the user-controlled `dir` with a predictable timestamp name. Avoids
    // symlink-bait races on shared work trees.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), '.wstack_patch_'));
    try {
      await fs.chmod(tmpDir, 0o700).catch(() => {
        /* best-effort on Windows */
      });
      const patchFile = path.join(tmpDir, 'in.diff');
      await fs.writeFile(patchFile, input.patch, { mode: 0o600 });

      const args = [`-p${strip}`, '--merge', ...(dryRun ? ['--dry-run'] : []), '-i', patchFile];

      const result = await runPatch(args, dir, opts.signal);

      if (result.exitCode !== 0 && !dryRun) {
        return {
          applied: 0,
          rejected: 1,
          files: [],
          dry_run: dryRun,
          message: `patch failed: ${result.stderr || result.stdout}`,
        };
      }

      const patched = extractPatchedFiles(result.stdout);
      return {
        applied: patched.length,
        rejected: 0,
        files: patched,
        dry_run: dryRun,
        message: result.stdout || 'patch applied',
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

/** Extract every `+++ <path>` target from a unified diff. */
function extractDiffTargets(patch: string): string[] {
  const out: string[] = [];
  // Matches `+++ path/to/file` and `+++ b/path/to/file` (also `a/`). Strips
  // optional tab-prefixed timestamp suffixes that some diff tools emit.
  // Cap each line at 4096 chars to prevent maliciously long lines from
  // causing regex backtracking issues in large patches.
  const re = /^\+\+\+\s+([^\t\r\n]+)/gm;
  for (const m of patch.matchAll(re)) {
    const raw = m[1];
    if (!raw) continue;
    const target = raw.length > 4096 ? raw.slice(0, 4096).trim() : raw.trim();
    if (!target || target === '/dev/null') continue;
    out.push(target);
  }
  return out;
}

/** Mimic `patch -pN` path stripping on a single target. Returns undefined
 *  if the path has fewer segments than `strip`. */
function stripPathComponents(p: string, strip: number): string | undefined {
  // Normalize separators so the count works on both POSIX and Windows-style
  // paths embedded in LLM-generated diffs. Filter out empty segments (e.g.
  // from trailing slashes or `//` sequences) before counting.
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length <= strip) return undefined;
  return parts.slice(strip).join('/');
}

function runPatch(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    // Force C locale so `extractPatchedFiles` (which greps for the English
    // "patching file" prefix) doesn't silently miss-count on systems with
    // localized GNU patch output (fr/de/es etc.). Use buildChildEnv to
    // strip API keys and other secrets from the parent environment.
    const env = { ...buildChildEnv(), LANG: 'C', LC_ALL: 'C' };
    const child = spawn('patch', args, { cwd, signal, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (e) => resolve({ exitCode: 1, stdout: '', stderr: e.message }));
  });
}

function extractPatchedFiles(output: string): string[] {
  const files: string[] = [];
  const re = /patching file (.+)/gi;
  for (const m of output.matchAll(re)) {
    if (m[1]) files.push(m[1]);
  }
  return files;
}
