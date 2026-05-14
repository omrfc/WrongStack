import type { Tool } from '@wrongstack/core';
import { formatHover } from '../formatters/hover.js';
import { humanToLSP } from '../position.js';
import { supportsHover } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import { readDocumentContent, requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

interface HoverInput {
  path: string;
  line: number;
  character: number;
}

export function createHoverTool(deps: ToolDeps): Tool<HoverInput, string> {
  return {
    name: 'lsp_hover',
    description: 'Get type information and documentation for a symbol.',
    usageHint: 'Use when you need a type/signature without opening the definition.',
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
        if (server.capabilities && !supportsHover(server.capabilities)) {
          throw new LSPError(LSPErrorCode.CapabilityMissing, `Server "${server.name}" does not support hover`);
        }
        const content = await readDocumentContent(file, deps.tracker);
        const position = humanToLSP(content, { line: input.line, character: input.character });
        return formatHover(await server.hover({ textDocument: { uri: pathToUri(file) }, position }, 5000, opts.signal));
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
