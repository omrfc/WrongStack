import type { Tool } from '@wrongstack/core';
import type { SymbolInformation } from 'vscode-languageserver-protocol';
import { formatDocumentSymbols, formatWorkspaceSymbols } from '../formatters/symbols.js';
import { supportsDocumentSymbol, supportsWorkspaceSymbol } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import { requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

interface SymbolsInput {
  path?: string;
  query?: string;
  limit?: number;
}

export function createSymbolsTool(deps: ToolDeps): Tool<SymbolsInput, string> {
  return {
    name: 'lsp_symbols',
    description: 'List symbols in a file or search workspace symbols.',
    usageHint: 'Pass `path` for a file outline, or `query` for workspace symbol search.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } },
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: 5000,
    async execute(input, ctx, opts) {
      try {
        if (input.path) {
          const file = resolveInputPath(input.path, ctx);
          const server = await requireServer(deps.registry, file, opts.signal);
          if (server.capabilities && !supportsDocumentSymbol(server.capabilities)) {
            throw new LSPError(LSPErrorCode.CapabilityMissing, `Server "${server.name}" does not support document symbols`);
          }
          const symbols = await server.documentSymbol({ textDocument: { uri: pathToUri(file) } }, 5000, opts.signal);
          return formatDocumentSymbols(file, symbols, ctx.cwd);
        }
        const query = input.query ?? '';
        const merged: SymbolInformation[] = [];
        for (const server of deps.registry.list()) {
          if (server.state !== 'ready') continue;
          if (server.capabilities && !supportsWorkspaceSymbol(server.capabilities)) continue;
          const result = await server.workspaceSymbol({ query }, 5000, opts.signal);
          if (result) merged.push(...result);
        }
        return formatWorkspaceSymbols(merged, query, ctx.cwd, input.limit ?? 100);
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
