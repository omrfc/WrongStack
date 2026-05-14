import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Tool } from '@wrongstack/core';
import { safeResolve } from './_util.js';

interface PatchInput {
  patch: string;
  directory?: string;
  strip?: number;
  dry_run?: boolean;
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
  description:
    'Apply a unified diff patch to files. Writes .orig and .rej files on failure.',
  usageHint:
    'Set `patch` (the diff text). `directory` defaults to cwd. `strip` removes leading path components. `dry_run` previews.',
  permission: 'confirm',
  mutating: true,
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
    const tmpDir = await fs.mkdtemp(path.join(dir, '.wstack_patch_'));
    try {
      await fs.chmod(tmpDir, 0o700).catch(() => { /* best-effort on Windows */ });
      const patchFile = path.join(tmpDir, 'in.diff');
      await fs.writeFile(patchFile, input.patch, { mode: 0o600 });

      const args = [
        `-p${strip}`,
        '--merge',
        ...(dryRun ? ['--dry-run'] : []),
        '-i', patchFile,
      ];

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
  const re = /^\+\+\+\s+([^\t\r\n]+)/gm;
  for (const m of patch.matchAll(re)) {
    const target = m[1]?.trim();
    if (!target || target === '/dev/null') continue;
    out.push(target);
  }
  return out;
}

/** Mimic `patch -pN` path stripping on a single target. Returns undefined
 *  if the path has fewer segments than `strip`. */
function stripPathComponents(p: string, strip: number): string | undefined {
  // Normalize separators so the count works on both POSIX and Windows-style
  // paths embedded in LLM-generated diffs.
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= strip) return undefined;
  return parts.slice(strip).join('/');
}

function runPatch(args: string[], cwd: string, signal: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    // Force C locale so `extractPatchedFiles` (which greps for the English
    // "patching file" prefix) doesn't silently miss-count on systems with
    // localized GNU patch output (fr/de/es etc.).
    const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
    const child = spawn('patch', args, { cwd, signal, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout?.on('data', (c) => { stdout += c.toString(); });
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
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