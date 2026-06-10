import { useEffect, useState } from 'react';
import { type GitInfo, readGitInfo } from '../git-info.js';

/**
 * Polls `git` every 5 seconds for the current branch and working-tree change
 * counts. Skipped silently when `cwd` isn't a repo or `git` isn't installed —
 * the value stays `null` and the consumer renders no chip.
 *
 * The interval is cleared on unmount; an in-flight `readGitInfo` whose result
 * arrives after unmount is discarded via the `cancelled` flag.
 */
export function useGitInfo(cwd: string | undefined): GitInfo | null {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const refresh = () => {
      readGitInfo(cwd)
        .then((info) => {
          if (!cancelled) setGitInfo(info);
        })
        .catch(() => undefined);
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [cwd]);
  return gitInfo;
}
