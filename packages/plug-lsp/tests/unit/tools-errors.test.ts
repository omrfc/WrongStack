import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCodeActionsTool } from '../../src/tools/code-actions.js';
import { createDefinitionTool } from '../../src/tools/definition.js';
import { createDiagnosticsTool } from '../../src/tools/diagnostics.js';
import { createHoverTool } from '../../src/tools/hover.js';
import { createReferencesTool } from '../../src/tools/references.js';
import { createRenameTool } from '../../src/tools/rename.js';
import {
  resolveInputPath,
  stringifyToolError,
  textDocumentPosition,
} from '../../src/tools/shared.js';
import { createSymbolsTool } from '../../src/tools/symbols.js';
import { applyWorkspaceEdit } from '../../src/tools/workspace-edit.js';
import { LSPError, LSPErrorCode, type PlugLSPConfig } from '../../src/types.js';
import { pathToUri } from '../../src/utils/uri.js';

const cfg: PlugLSPConfig = {
  servers: {},
  autoStart: 'lazy',
  diagnosticsAfterEdit: 'background',
  diagnosticsWaitMs: 1,
  severityFilter: ['error', 'warning'],
  maxDiagnosticsPerFile: 5,
  maxDiagnosticsTotal: 50,
  autoDiscover: false,
  logServerOutput: false,
};

describe('tool error and edge paths', () => {
  it('formats shared helper paths and errors', () => {
    const cwd = process.cwd();
    expect(resolveInputPath('a.ts', { cwd } as never)).toBe(path.join(cwd, 'a.ts'));
    expect(
      textDocumentPosition(path.join(cwd, 'a.ts'), { line: 1, character: 2 }).textDocument.uri,
    ).toBe(pathToUri(path.join(cwd, 'a.ts')));
    expect(stringifyToolError(new LSPError(LSPErrorCode.ServerFailed, 'failed'))).toContain(
      'LSP_SERVER_FAILED',
    );
    expect(stringifyToolError(new Error('boom'))).toContain('boom');
    expect(stringifyToolError('wat')).toContain('wat');
  });

  it('returns capability and not-found errors from read-only tools', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-tools-'));
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'const a = 1;');
    const server = fakeServer({});
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;
    const opts = { signal: new AbortController().signal };
    expect(
      await createHoverTool(deps).execute({ path: file, line: 1, character: 1 }, ctx, opts),
    ).toContain('does not support hover');
    expect(await createCodeActionsTool(deps).execute({ path: file, line: 1 }, ctx, opts)).toContain(
      'does not support code actions',
    );
    expect(
      await createDefinitionTool(deps).execute({ path: file, line: 1, character: 1 }, ctx, opts),
    ).toContain('does not support definition');
    expect(
      await createReferencesTool(deps).execute(
        { path: file, line: 1, character: 1, include_declaration: false, limit: 1 },
        ctx,
        opts,
      ),
    ).toContain('does not support references');
    expect(await createSymbolsTool(deps).execute({ path: file }, ctx, opts)).toContain(
      'does not support document symbols',
    );
    expect(
      await createDiagnosticsTool(makeDeps(null)).execute({ path: file }, ctx, opts),
    ).toContain('LSP_SERVER_NOT_FOUND');
  });

  it('covers diagnostics workspace mode, rename no-edit, and code action edge cases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-tools-'));
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'const a = 1;');
    const uri = pathToUri(file);
    const server = fakeServer({
      capabilities: {
        diagnosticProvider: {},
        renameProvider: true,
        codeActionProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
      },
      pullDiagnostics: vi.fn(async () => [{ range: r(0, 0), severity: 1, message: 'pulled' }]),
      getDiagnostics: vi.fn(() => [{ range: r(0, 0), severity: 2, message: 'buffered' }]),
      rename: vi.fn(async () => null),
      codeAction: vi.fn(async () => []),
      documentSymbol: vi.fn(async () => null),
      workspaceSymbol: vi.fn(async () => null),
    });
    const deps = makeDeps(server, [{ path: file, uri }]);
    const ctx = { cwd: root } as never;
    const opts = { signal: new AbortController().signal };
    expect(
      await createDiagnosticsTool(deps).execute({ path: file, limit: 1 }, ctx, opts),
    ).toContain('pulled');
    server.capabilities = {};
    expect(
      await createDiagnosticsTool(deps).execute({ path: file, limit: 1 }, ctx, opts),
    ).toContain('buffered');
    server.capabilities = {
      diagnosticProvider: {},
      renameProvider: true,
      codeActionProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
    };
    expect(await createDiagnosticsTool(deps).execute({}, ctx, opts)).toContain('buffered');
    expect(
      await createRenameTool(deps).execute(
        { path: file, line: 1, character: 1, new_name: 'b' },
        ctx,
        opts,
      ),
    ).toBe('Rename produced no edits.');
    expect(await createSymbolsTool(deps).execute({ path: file }, ctx, opts)).toBe(
      'No symbols found.',
    );
    expect(await createCodeActionsTool(deps).execute({ path: file, line: 1 }, ctx, opts)).toBe(
      'No code actions available.',
    );
    expect(
      await createCodeActionsTool(deps).execute(
        { path: file, line: 1, kind_filter: 'quickfix' },
        ctx,
        opts,
      ),
    ).toBe('No code actions available.');
    expect(
      await createCodeActionsTool(deps).execute({ path: file, line: 1, apply: 1 }, ctx, opts),
    ).toBe('No code action at index 1.');
    expect(await createSymbolsTool(deps).execute({ query: 'x', limit: 1 }, ctx, opts)).toBe(
      'No symbols matching "x".',
    );
    expect(
      await createSymbolsTool(
        makeDeps([
          {
            state: 'failed',
            capabilities: { workspaceSymbolProvider: true },
            workspaceSymbol: vi.fn(),
          },
          { state: 'ready', capabilities: {}, workspaceSymbol: vi.fn() },
        ]),
      ).execute({ query: 'x' }, ctx, opts),
    ).toBe('No symbols matching "x".');
  });

  it('applies command-only actions and rolls back failed workspace edits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-tools-'));
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'const a = 1;');
    const server = fakeServer({
      capabilities: { codeActionProvider: true },
      codeAction: vi.fn(async () => [{ title: 'Run command', command: { command: 'do.it' } }]),
      executeCommand: vi.fn(async () => 'ok'),
    });
    const deps = makeDeps(server);
    const out = await createCodeActionsTool(deps).execute(
      { path: file, line: 1, apply: 0 },
      { cwd: root } as never,
      { signal: new AbortController().signal },
    );
    expect(out).toContain('Executed command: do.it');

    const missing = path.join(root, 'missing.ts');
    await expect(
      applyWorkspaceEdit(
        {
          changes: {
            [pathToUri(file)]: [{ range: r(0, 0), newText: 'let' }],
            [pathToUri(missing)]: [{ range: r(0, 0), newText: 'x' }],
          },
        },
        { fileWritten: vi.fn() } as never,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(file, 'utf8')).toBe('const a = 1;');
    await applyWorkspaceEdit(
      {
        changes: {
          [pathToUri(file)]: [
            {
              range: { start: { line: 99, character: 0 }, end: { line: 99, character: 0 } },
              newText: '!',
            },
          ],
        },
      },
      { fileWritten: vi.fn(async () => undefined) } as never,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('!const a = 1;');
  });
});

function makeDeps(server: unknown, docs: Array<{ path: string; uri: string }> = []) {
  return {
    registry: {
      findForPath: vi.fn(async () => server),
      list: vi.fn(() => (Array.isArray(server) ? server : server ? [server] : [])),
    },
    tracker: {
      get: vi.fn(() => null),
      list: vi.fn(() => docs),
      fileWritten: vi.fn(async () => undefined),
    },
    cfg,
    log: {},
  } as never;
}

function fakeServer(overrides: Record<string, unknown>) {
  return {
    name: 'fake',
    state: 'ready',
    capabilities: {},
    hover: vi.fn(),
    definition: vi.fn(),
    references: vi.fn(),
    documentSymbol: vi.fn(),
    workspaceSymbol: vi.fn(),
    rename: vi.fn(),
    codeAction: vi.fn(),
    executeCommand: vi.fn(),
    pullDiagnostics: vi.fn(),
    getDiagnostics: vi.fn(() => []),
    ...overrides,
  };
}

function r(line: number, character: number) {
  return { start: { line, character }, end: { line, character: character + 1 } };
}
