import * as fs from 'node:fs';
import * as path from 'node:path';

export function findWorkspaceRoot(
  filePath: string,
  rootPatterns: string[] | undefined,
  fallback: string,
): string {
  const patterns = rootPatterns?.length ? rootPatterns : [];
  if (patterns.length === 0) return path.resolve(fallback);

  let dir = path.dirname(path.resolve(filePath));
  const stop = path.parse(dir).root;
  for (;;) {
    for (const pattern of patterns) {
      if (matchesAt(dir, pattern)) return dir;
    }
    if (dir === stop) return path.resolve(fallback);
    dir = path.dirname(dir);
  }
}

function matchesAt(dir: string, pattern: string): boolean {
  if (!pattern.includes('*')) return fs.existsSync(path.join(dir, pattern));
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp(`^${escaped}$`);
  try {
    return fs.readdirSync(dir).some((name) => re.test(name));
  } catch {
    return false;
  }
}
