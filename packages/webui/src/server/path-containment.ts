import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function resolveWorkingDirInsideProject(projectRoot: string, inputPath: string): Promise<string> {
  const resolved = path.resolve(projectRoot, inputPath);

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`Directory not found or not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found or not accessible: ${resolved}`);
  }

  const [realProjectRoot, realResolved] = await Promise.all([
    fs.realpath(projectRoot),
    fs.realpath(resolved),
  ]);

  if (!isPathInside(realProjectRoot, realResolved)) {
    throw new Error(`Path must stay inside the project root: ${projectRoot}`);
  }

  return resolved;
}
