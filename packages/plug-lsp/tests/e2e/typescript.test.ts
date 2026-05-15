import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus, type Logger } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPRegistry } from '../../src/registry.js';
import { makeLSPTools } from '../../src/tools/index.js';
import type { PlugLSPConfig } from '../../src/types.js';

const hasTypeScriptLanguageServer = commandExists('typescript-language-server');

const log: Logger = {
  level: 'error',
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return this;
  },
};

describe.skipIf(!hasTypeScriptLanguageServer)('typescript-language-server E2E', () => {
  it('returns diagnostics and hover from a real TypeScript server', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-ts-'));
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ type: 'module', devDependencies: { typescript: '*' } }),
    );
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' } }),
    );
    const source = path.join(root, 'index.ts');
    await fs.writeFile(source, 'export const answer: number = "nope";\nanswer;\n');

    const cfg: PlugLSPConfig = {
      servers: {
        typescript: {
          command: 'typescript-language-server',
          args: ['--stdio'],
          languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
          rootPatterns: ['tsconfig.json', 'package.json'],
          startupTimeoutMs: 15_000,
          enabled: true,
        },
      },
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      diagnosticsWaitMs: 1500,
      severityFilter: ['error', 'warning'],
      maxDiagnosticsPerFile: 20,
      maxDiagnosticsTotal: 50,
      autoDiscover: false,
      logServerOutput: false,
    };

    const holder: { registry?: LSPRegistry } = {};
    const tracker = new DocumentTracker(() => holder.registry!, log, root);
    const registry = new LSPRegistry(cfg, tracker, { cwd: root, log, events: new EventBus() });
    holder.registry = registry;
    await registry.bind(root, 'lazy');
    await tracker.open(source);

    const tools = new Map(
      makeLSPTools({ registry, tracker, cfg, log }).map((tool) => [tool.name, tool]),
    );
    const ctx = { cwd: root, projectRoot: root } as never;
    const signal = new AbortController().signal;

    const hover = await tools
      .get('lsp_hover')!
      .execute({ path: source, line: 1, character: 14 }, ctx, { signal });
    expect(String(hover)).toContain('answer');

    const diagnostics = await tools
      .get('lsp_diagnostics')!
      .execute({ path: source }, ctx, { signal });
    expect(String(diagnostics).toLowerCase()).toContain('string');

    await registry.shutdown();
  }, 30_000);
});

function commandExists(command: string): boolean {
  const result =
    process.platform === 'win32'
      ? spawnSync('where.exe', [command], { stdio: 'ignore' })
      : spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], { stdio: 'ignore' });
  return result.status === 0;
}
