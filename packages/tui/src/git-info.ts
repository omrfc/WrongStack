import { spawn } from 'node:child_process';

export interface GitInfo {
  branch: string;
  /** Total lines added in working tree vs HEAD (staged + unstaged). */
  added: number;
  /** Total lines deleted in working tree vs HEAD (staged + unstaged). */
  deleted: number;
  /** Count of untracked files in the working tree. */
  untracked: number;
}

/**
 * Read git branch + change summary for the given cwd. Returns `null`
 * when the directory isn't a git repository or git isn't installed —
 * the status bar just hides the git chip in that case.
 *
 * Spawns two short-lived `git` processes in parallel. Cheap enough to
 * call on a 3–5 second interval; the caller is responsible for the
 * cadence (this function is purely fire-and-result).
 */
export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  const [branchRes, numstatRes, statusRes] = await Promise.all([
    runGit(cwd, ['branch', '--show-current']),
    runGit(cwd, ['diff', 'HEAD', '--numstat']),
    runGit(cwd, ['status', '--porcelain']),
  ]);

  // If any of the three failed with a non-zero exit OR git wasn't
  // found, we're not in a repo (or git is missing) — bail entirely.
  if (!branchRes.ok || !numstatRes.ok || !statusRes.ok) return null;

  const branch = branchRes.stdout.trim();
  // Detached HEAD: `branch --show-current` returns empty. Render the
  // short SHA instead so the chip isn't blank.
  const branchLabel = branch || (await detachedShortSha(cwd)) || 'detached';

  let added = 0;
  let deleted = 0;
  for (const line of numstatRes.stdout.split('\n')) {
    if (!line) continue;
    const [a, d] = line.split('\t');
    // Binary files report '-' for both columns — skip them.
    if (a && a !== '-') added += Number.parseInt(a, 10) || 0;
    if (d && d !== '-') deleted += Number.parseInt(d, 10) || 0;
  }

  let untracked = 0;
  for (const line of statusRes.stdout.split('\n')) {
    if (line.startsWith('?? ')) untracked++;
  }

  return { branch: branchLabel, added, deleted, untracked };
}

async function detachedShortSha(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  return res.ok ? res.stdout.trim() : null;
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    try {
      const child = spawn('git', args, {
        cwd,
        // Inherit stderr (silent) — we don't care about git's noise.
        stdio: ['ignore', 'pipe', 'ignore'],
        // Don't let a slow git hang the TUI.
        timeout: 3000,
        windowsHide: true,
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('error', () => resolve({ ok: false, stdout: '' }));
      child.on('close', (code) => {
        resolve({ ok: code === 0, stdout });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}
