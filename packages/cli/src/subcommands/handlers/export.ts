import { expectDefined } from '@wrongstack/core';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DefaultSessionReader } from '@wrongstack/core';
import type { SubcommandHandler } from '../index.js';
export const exportCmd: SubcommandHandler = async (args, deps) => {
  if (!deps.sessionStore) {
    deps.renderer.writeError('No session store configured.');
    return 1;
  }
  let format: 'markdown' | 'json' | 'text' = 'markdown';
  let output: string | undefined;
  let includeTools = true;
  let includeDiagnostics = true;
  let sessionId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = expectDefined(args[i]);
    if (a === '--format' || a === '-f') {
      const v = args[++i];
      if (v !== 'markdown' && v !== 'json' && v !== 'text') {
        deps.renderer.writeError(`Unknown --format ${v}. Use markdown, json, or text.`);
        return 1;
      }
      format = v;
    } else if (a === '--out' || a === '-o') output = args[++i];
    else if (a === '--no-tools') includeTools = false;
    else if (a === '--no-diagnostics') includeDiagnostics = false;
    else if (a.startsWith('-')) {
      deps.renderer.writeError(`Unknown flag: ${a}`);
      return 1;
    } else if (!sessionId) sessionId = a;
  }
  if (!sessionId) {
    deps.renderer.writeError(
      'Usage: wstack export <sessionId> [--format markdown|json|text] [--out <file>] [--no-tools] [--no-diagnostics]',
    );
    return 1;
  }
  const reader = new DefaultSessionReader({ store: deps.sessionStore });
  let rendered: string;
  try {
    rendered = await reader.export(sessionId, { format, includeTools, includeDiagnostics });
  } catch (err) {
    deps.renderer.writeError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(deps.cwd, output)), { recursive: true });
    await fs.writeFile(path.resolve(deps.cwd, output), rendered, 'utf8');
    deps.renderer.write(`Wrote ${rendered.length} bytes to ${output}\n`);
  } else {
    deps.renderer.write(rendered);
    if (!rendered.endsWith('\n')) deps.renderer.write('\n');
  }
  return 0;
};
