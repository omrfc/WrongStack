import type { Tool } from '@wrongstack/core';
import { supportsPullDiagnostics } from '../server/capabilities.js';
import { formatDiagnostics } from '../formatters/diagnostics.js';
import { pathToUri, uriToPath } from '../utils/uri.js';
import { requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

interface DiagnosticsInput {
  path?: string;
  limit?: number;
}

export function createDiagnosticsTool(deps: ToolDeps): Tool<DiagnosticsInput, string> {
  return {
    name: 'lsp_diagnostics',
    description: 'Get diagnostics from configured language servers.',
    usageHint: 'Use after reading or editing a file when an LSP server is configured. Pass `path` for file diagnostics or omit it for tracked workspace diagnostics.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } } },
    permission: 'auto',
    mutating: false,
    timeoutMs: 5000,
    maxOutputBytes: 65_536,
    async execute(input, ctx, opts) {
      try {
        const byFile = new Map<string, import('vscode-languageserver-protocol').Diagnostic[]>();
        if (input.path) {
          const file = resolveInputPath(input.path, ctx);
          const server = await requireServer(deps.registry, file, opts.signal);
          const uri = pathToUri(file);
          const diagnostics = server.capabilities && supportsPullDiagnostics(server.capabilities)
            ? await server.pullDiagnostics(uri, 5000, opts.signal)
            : server.getDiagnostics(uri);
          byFile.set(file, diagnostics);
        } else {
          for (const doc of deps.tracker.list()) {
            const server = await deps.registry.findForPath(doc.path, opts.signal);
            if (!server) continue;
            byFile.set(uriToPath(doc.uri), server.getDiagnostics(doc.uri));
          }
        }
        return formatDiagnostics(byFile, {
          cwd: ctx.cwd,
          severityFilter: deps.cfg.severityFilter,
          maxPerFile: deps.cfg.maxDiagnosticsPerFile,
          maxTotal: input.limit ?? deps.cfg.maxDiagnosticsTotal,
        });
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
