/**
 * Shared `git.info` WebSocket handler for both the standalone WebUI server and
 * the CLI's `--webui` embedded server. Extracted from the duplicated switch
 * cases in `index.ts` and `cli/src/webui-server.ts`, which had drifted (the
 * standalone copy transposed ahead/behind and never matched deletions). One
 * implementation here keeps both surfaces in lockstep.
 *
 *   case 'git.info': return handleGitInfo(ws, projectRoot);
 */

import type { WebSocket } from 'ws';
import { send } from './ws-utils.js';

/**
 * Read git branch, change stats, and upstream sync status from `projectRoot`
 * and broadcast a `git.info` message. Never throws — a non-repo / missing-git
 * directory yields an empty-but-valid payload.
 */
export async function handleGitInfo(ws: WebSocket, projectRoot: string): Promise<void> {
  const cwd = projectRoot || undefined;
  try {
    const { execFile: ef } = await import('node:child_process');
    const git = (args: string[]): Promise<string> =>
      new Promise((resolve) => {
        ef('git', args, { cwd, timeout: 3000 }, (err: Error | null, stdout: string) => {
          resolve(err ? '' : stdout.trim());
        });
      });

    const [branchRaw, diffRaw, statusRaw, upstreamRaw] = await Promise.all([
      git(['branch', '--show-current']),
      git(['diff', '--stat']),
      git(['status', '--porcelain']),
      git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    ]);

    const branch = branchRaw || '(detached)';

    // `git diff --stat` summary line: "N files changed, X insertions(+), Y deletions(-)".
    // Deletions are formatted "Y deletions(-)" — the `+` only ever precedes
    // INSERTIONS, so a `\+`-anchored deletion regex never matches.
    const addMatch = /(\d+)\s+insertion/i.exec(diffRaw);
    const delMatch = /(\d+)\s+deletion/i.exec(diffRaw);
    const added = addMatch ? Number(addMatch[1]) : 0;
    const deleted = delMatch ? Number(delMatch[1]) : 0;

    // Untracked files from `git status --porcelain` (lines starting with "??").
    const untracked = statusRaw.split('\n').filter((l) => l.startsWith('??')).length;

    // `git rev-list --left-right --count @{upstream}...HEAD` prints "<behind>\t<ahead>":
    // left = commits in upstream not in HEAD (BEHIND), right = HEAD-only (AHEAD).
    const [behindRaw, aheadRaw] = (upstreamRaw || '0\t0').split('\t');
    const behind = Number(behindRaw) || 0;
    const ahead = Number(aheadRaw) || 0;

    send(ws, { type: 'git.info', payload: { branch, added, deleted, untracked, ahead, behind } });
  } catch {
    // Git not available or not a repo — send empty info silently.
    send(ws, { type: 'git.info', payload: { branch: '', added: 0, deleted: 0, untracked: 0, ahead: 0, behind: 0 } });
  }
}
