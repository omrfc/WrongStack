import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function pathToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).toString();
}

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

export function displayPath(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : filePath;
}
