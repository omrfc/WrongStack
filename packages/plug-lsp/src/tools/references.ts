import type { Tool } from '@wrongstack/core';
import { formatLocations } from '../formatters/location.js';
import { humanToLSP } from '../position.js';
import { supportsReferences } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import { readDocumentContent, requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

interface ReferencesInput {
  path: string;
  line: number;
  character: number;
  include_declaration?: boolean;
  limit?: number;
}

export function createReferencesTool(deps: ToolDeps): Tool<ReferencesInput, string> {
  return {
    name: 'lsp_references',
    description: 'Find references to a symbol.',
    usageHint: 'Use instead of grep when the symbol position is known; it is syntax-aware.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
        include_declaration: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      required: ['path', 'line', 'character'],
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: 10_000,
    async execute(input, ctx, opts) {
      try {
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, opts.signal);
        if (server.capabilities && !supportsReferences(server.capabilities)) {
          throw new LSPError(LSPErrorCode.CapabilityMissing, `Server "${server.name}" does not support references`);
        }
        const content = await readDocumentContent(file, deps.tracker);
        const position = humanToLSP(content, { line: input.line, character: input.character });
        const locs = await server.references({
          textDocument: { uri: pathToUri(file) },
          position,
          context: { includeDeclaration: input.include_declaration ?? true },
        }, 10_000, opts.signal);
        return formatLocations(locs, ctx.cwd, input.limit ?? 100);
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
