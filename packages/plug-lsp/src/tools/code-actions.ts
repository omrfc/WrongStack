import type { Tool } from '@wrongstack/core';
import type { CodeAction } from 'vscode-languageserver-protocol';
import { summarizeWorkspaceEdit } from '../formatters/workspace-edit.js';
import { humanToLSP } from '../position.js';
import { supportsCodeAction } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import {
  type ToolDeps,
  readDocumentContent,
  requireServer,
  resolveInputPath,
  stringifyToolError,
} from './shared.js';
import { applyWorkspaceEdit } from './workspace-edit.js';

interface CodeActionsInput {
  path: string;
  line: number;
  character?: number | undefined;
  end_line?: number | undefined;
  end_character?: number | undefined;
  apply?: number | undefined;
  kind_filter?: string | undefined;
}

export function createCodeActionsTool(deps: ToolDeps): Tool<CodeActionsInput, string> {
  return {
    name: 'lsp_code_actions',
    description: 'List or apply LSP code actions.',
    usageHint:
      'Use to inspect quick fixes and refactors. This tool is confirm-gated because apply mode can mutate files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
        end_line: { type: 'integer' },
        end_character: { type: 'integer' },
        apply: { type: 'integer' },
        kind_filter: { type: 'string' },
      },
      required: ['path', 'line'],
    },
    permission: 'confirm',
    mutating: true,
    timeoutMs: 10_000,
    async execute(input, ctx, opts) {
      try {
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, opts.signal);
        if (server.capabilities && !supportsCodeAction(server.capabilities)) {
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not support code actions`,
          );
        }
        const content = await readDocumentContent(file, deps.tracker);
        const start = humanToLSP(content, { line: input.line, character: input.character ?? 1 });
        const end = humanToLSP(content, {
          line: input.end_line ?? input.line,
          character: input.end_character ?? input.character ?? 1,
        });
        const actions = await server.codeAction(
          {
            textDocument: { uri: pathToUri(file) },
            range: { start, end },
            context: {
              diagnostics: server.getDiagnostics(pathToUri(file)),
              ...(input.kind_filter ? { only: [input.kind_filter] } : {}),
            },
          },
          10_000,
          opts.signal,
        );
        if (input.apply === undefined) return formatActions(actions);
        const action = actions[input.apply];
        if (!action) return `No code action at index ${input.apply}.`;
        const parts: string[] = [`Applying [${input.apply}] ${action.title}`];
        if (action.edit) {
          parts.push(summarizeWorkspaceEdit(action.edit, ctx.cwd));
          const applied = await applyWorkspaceEdit(action.edit, deps.tracker);
          parts.push(`Applied: ${applied.edits} edits across ${applied.files.length} files.`);
        }
        if (action.command) {
          await server.executeCommand(action.command, 10_000, opts.signal);
          parts.push(`Executed command: ${action.command.command}`);
        }
        return parts.join('\n');
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}

function formatActions(actions: CodeAction[]): string {
  if (actions.length === 0) return 'No code actions available.';
  return actions.map((a, i) => `[${i}] ${a.kind ?? 'action'} ${a.title}`).join('\n');
}
