import * as path from 'node:path';

// Best-effort heuristic detection of destructive shell commands — NOT a
// security boundary. Static analysis of shell strings is inherently defeatable
// by obfuscation: env-variable indirection (`$RM -rf /`), quote-splitting
// (`r''m`), base64/eval pipes (`echo ... | base64 -d | sh`), command
// substitution (`$(printf rm) -rf`), and aliases all evade these patterns.
// This is one defense-in-depth layer behind the permission policy and the
// project-escape checks below, not the sole gate. Treat a miss here as
// expected, not as a hole to be plugged with ever-more-clever regexes.
const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
  /\bgit\s+(?:clean\s+-[^\s]*[xdf]|reset\s+--hard)\b/i,
  /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i,
  /\bdelete\s+from\b/i,
  /\b(?:mkfs|format|diskpart|shutdown|reboot)\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bchown\s+-R\b/i,
  /\b(?:curl|wget)\b.*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i,
  /\b(?:powershell|pwsh)\b.*(?:-encodedcommand|-enc)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*}\s*;/,
];

const PROJECT_ESCAPE_PATTERN = /(?:^|[\s"'])\.\.(?:[\\/]|$)/;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'])(?:~[\\/]|\/[A-Za-z0-9_.-]|[A-Za-z]:[\\/])/;
const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '>', '>>', '<', '2>', '2>>']);

export function getInputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function pathLooksInsideProject(rawPath: string, projectRoot: string | undefined): boolean {
  if (!projectRoot) return false;
  // A leading ~ is the home directory, never the project root. Without this,
  // path.resolve() treats "~/cache" as a relative path *inside* the project
  // (there is no shell tilde-expansion here), masking an escape like `rm -rf ~/cache`.
  if (rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return false;
  const resolved = path.resolve(projectRoot, rawPath);
  const relative = path.relative(projectRoot, resolved);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function tokenizeShell(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
}

function pathTokenIsOutsideProject(token: string, projectRoot: string | undefined): boolean {
  if (!token || SHELL_OPERATORS.has(token) || token.startsWith('-')) return false;
  if (token === '/' || token === '~' || token === '.' || token === '..') return token !== '.';
  if (token.includes('*')) return true;
  if (token.startsWith('..') || token.includes('../') || token.includes('..\\')) return true;
  if (path.isAbsolute(token) || token.startsWith('~/')) return !pathLooksInsideProject(token, projectRoot);
  return false;
}

function hasDangerousDeleteTarget(
  tokens: string[],
  start: number,
  projectRoot: string | undefined,
): boolean {
  const targets = tokens
    .slice(start)
    .filter((token) => !token.startsWith('-') && !SHELL_OPERATORS.has(token));
  if (targets.length === 0) return true;
  return targets.some((target) => pathTokenIsOutsideProject(target, projectRoot));
}

function hasDestructiveDelete(command: string, projectRoot: string | undefined): boolean {
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]?.toLowerCase();
    if (!token) continue;

    if (token === 'rm') {
      const args = tokens.slice(i + 1);
      const recursiveOrForce = args.some(
        (arg) => /^-[^-]*[rf]/i.test(arg) || arg === '--recursive' || arg === '--force',
      );
      if (recursiveOrForce && hasDangerousDeleteTarget(tokens, i + 1, projectRoot)) return true;
    }

    if (token === 'rmdir' || token === 'rd') {
      const args = tokens.slice(i + 1);
      const recursive = args.some((arg) => arg.toLowerCase() === '/s');
      if (recursive && hasDangerousDeleteTarget(tokens, i + 1, projectRoot)) return true;
    }

    if (token === 'del' || token === 'erase') {
      if (hasDangerousDeleteTarget(tokens, i + 1, projectRoot)) return true;
    }

    if (token === 'remove-item') {
      const args = tokens.slice(i + 1).map((arg) => arg.toLowerCase());
      const recursiveOrForce = args.includes('-recurse') || args.includes('-force');
      if (recursiveOrForce && hasDangerousDeleteTarget(tokens, i + 1, projectRoot)) return true;
    }
  }
  return false;
}

export function isClearlyDestructiveBashCommand(
  command: string,
  projectRoot: string | undefined,
): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (hasDestructiveDelete(trimmed, projectRoot)) return true;
  if (DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;

  // Changing directory or targeting paths outside the project turns arbitrary
  // shell from "normal workspace work" into something the user should see.
  if (/\bcd\s+(?:\.\.|~|\/|[A-Za-z]:[\\/])/i.test(trimmed)) return true;
  if (PROJECT_ESCAPE_PATTERN.test(trimmed)) return true;

  const absolute = trimmed.match(ABSOLUTE_PATH_PATTERN)?.[0]?.trim().replace(/^['"]|['"]$/g, '');
  if (absolute && !pathLooksInsideProject(absolute, projectRoot)) return true;

  return false;
}
