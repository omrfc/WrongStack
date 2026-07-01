import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readBundledInstructionText(relativePath: string): string {
  for (const root of instructionRootCandidates()) {
    try {
      return readFileSync(path.join(root, relativePath), 'utf8').trimEnd();
    } catch {
      // try next candidate
    }
  }
  return '';
}

export function renderInstructionTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] ?? '' : match,
  );
}

function instructionRootCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../instructions'),
    path.resolve(here, '../instructions'),
    path.resolve(here, 'instructions'),
  ];
  return candidates.sort((a, b) => Number(!isDirectory(a)) - Number(!isDirectory(b)));
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
