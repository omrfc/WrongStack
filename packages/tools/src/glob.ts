import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compileGlob } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';
import { safeResolve } from './_util.js';

interface GlobInput {
  pattern: string;
  path?: string | undefined;
  limit?: number | undefined;
}

interface GlobOutput {
  files: string[];
  truncated: boolean;
}

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo'];

export const globTool: Tool<GlobInput, GlobOutput> = {
  name: 'glob',
  category: 'Filesystem',
  description:
    'Find files matching a glob pattern. Fast way to discover relevant files before reading, grepping, or editing them.',
  usageHint:
    'RECOMMENDED FOR SCOPING SEARCHES:\n\n' +
    '- Use early to get a list of files you actually care about.\n' +
    '- Combine with `path` and `limit`.\n' +
    '- Default ignores common build/dependency directories.\n' +
    'Much more efficient than shell `find` for most use cases inside the agent.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  maxOutputBytes: 65_536,
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match (e.g. "**/*.ts", "src/**").',
      },
      path: {
        type: 'string',
        description: 'Base directory to search from (defaults to project root).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results to return (default 1000, max 5000).',
      },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    if (!input?.pattern) throw new Error('glob: pattern is required');
    const base = input.path ? safeResolve(input.path, ctx) : ctx.cwd;
    const limit = Math.max(1, Math.min(input.limit ?? 1000, 5000));

    const ignored = await readGitignore(base);
    const re = compileGlob(input.pattern);

    const results: { rel: string; mtime: number }[] = [];
    let truncated = false;
    const walk = async (dir: string, relPrefix: string): Promise<void> => {
      /* v8 ignore start -- the inner limit guards (file push + post-recursion return) always stop first; this re-entry guard is defensive. */
      if (results.length >= limit) {
        truncated = true;
        return;
      }
      /* v8 ignore stop */
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const name = e.name;
        if (DEFAULT_IGNORE.includes(name)) continue;
        if (ignored.includes(name)) continue;
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const full = path.join(dir, name);
        if (e.isDirectory()) {
          await walk(full, rel);
          if (truncated) return;
        } else if (e.isFile()) {
          if (re.test(rel) || re.test(name)) {
            try {
              const st = await fs.stat(full);
              results.push({ rel: full, mtime: st.mtimeMs });
              if (results.length >= limit) {
                truncated = true;
                return;
              }
            } catch {
              // skip stat error
            }
          }
        }
      }
    };
    await walk(base, '');
    results.sort((a, b) => b.mtime - a.mtime);
    return { files: results.map((r) => r.rel), truncated };
  },
};

async function readGitignore(dir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}
