/**
 * Pure filtering + ranking for the `files.list` project file picker (the chat
 * `@`-mention popup). The directory *walk* stays in index.ts (it's I/O), but
 * the two decisions that shape the result — which entries to hide and how to
 * rank matches — are pure and live here so the scoring weights, depth penalty,
 * and tie-break order can be unit tested. A silently-flipped weight would make
 * the picker feel subtly wrong with nothing to catch it.
 */
/** Heavyweight build/vcs/dependency dirs the picker never descends into. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'target',
  'coverage',
  '.nyc_output',
  'out',
  '.pnpm-store',
  '.parcel-cache',
]);

/** Dotfiles/dirs kept despite the hide-dotfiles-by-default rule. */
const KEEP_DOTFILES: ReadonlySet<string> = new Set([
  '.wrongstack',
  '.env.example',
  '.gitignore',
  '.eslintrc',
  '.prettierrc',
]);

/**
 * Whether a directory entry should be hidden from the picker by its name.
 * Dotfiles are hidden by default, except a few commonly-wanted ones.
 */
export function isHiddenEntry(name: string): boolean {
  return name.startsWith('.') && !KEEP_DOTFILES.has(name);
}

/**
 * Rank `paths` against `query` and return up to `limit` paths, best first.
 *
 * Scoring (cheap heuristic, good enough for a picker): exact basename match
 * (100) > basename prefix (60) > path substring (20); non-matches are dropped.
 * Each match is penalized by its path depth so root files sort first. Ties
 * break by lexicographic path. An empty query keeps every path (score 0), so
 * the result is the paths sorted lexicographically, capped to `limit`.
 */
export function rankFiles(paths: readonly string[], query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const p of paths) {
    if (!q) {
      scored.push({ path: p, score: 0 });
      continue;
    }
    const lower = p.toLowerCase();
    const base = lower.split('/').pop() ?? lower;
    let score = 0;
    if (base === q) score = 100;
    else if (base.startsWith(q)) score = 60;
    else if (lower.includes(q)) score = 20;
    else continue;
    // Penalise depth so root files come first.
    score -= p.split('/').length;
    scored.push({ path: p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}
