import type { SlashCommand } from '@wrongstack/core';
import type { LSPRegistry } from '../registry.js';
import { formatDiagnostics } from '../formatters/diagnostics.js';
import { uriToPath } from '../utils/uri.js';

export function diagnosticsCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'diagnostics',
    description: 'Print buffered LSP diagnostics.',
    async run(_args, ctx) {
      const byFile = new Map<string, import('vscode-languageserver-protocol').Diagnostic[]>();
      for (const server of registry.list()) {
        for (const [uri, diagnostics] of server.diagnostics.entries()) {
          byFile.set(uriToPath(uri), diagnostics);
        }
      }
      return {
        message: formatDiagnostics(byFile, {
          cwd: ctx.cwd,
          severityFilter: ['error', 'warning'],
          maxPerFile: 10,
          maxTotal: 100,
        }),
      };
    },
  };
}
