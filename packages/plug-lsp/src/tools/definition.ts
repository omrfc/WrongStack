import type { Tool } from '@wrongstack/core';
import { formatLocations } from '../formatters/location.js';
import { supportsDefinition } from '../server/capabilities.js';
import { humanToLSP } from '../position.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import { readDocumentContent, requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

interface PositionInput {
  path: string;
  line: number;
  character: number;
}

export function createDefinitionTool(deps: ToolDeps): Tool<PositionInput, string> {
  return {
    name: 'lsp_definition',
    description: 'Find where a symbol is defined.',
    usageHint: 'Use for semantic navigation when you know the symbol position. Lines and columns are 1-based.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, line: { type: 'integer' }, character: { type: 'integer' } },
      required: ['path', 'line', 'character'],
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: 5000,
    async execute(input, ctx, opts) {
      try {
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, opts.signal);
        if (server.capabilities && !supportsDefinition(server.capabilities)) {
          throw new LSPError(LSPErrorCode.CapabilityMissing, `Server "${server.name}" does not support definition`);
        }
        const content = await readDocumentContent(file, deps.tracker);
        const position = humanToLSP(content, { line: input.line, character: input.character });
        const locs = await server.definition({ textDocument: { uri: pathToUri(file) }, position }, 5000, opts.signal);
        return formatLocations(locs, ctx.cwd);
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
