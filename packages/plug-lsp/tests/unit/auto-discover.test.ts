import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoDiscoverServers } from '../../src/auto-discover.js';

describe('autoDiscoverServers', () => {
  it('finds project-local language server binaries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-bin-'));
    const binDir = path.join(root, 'node_modules', '.bin');
    await fs.mkdir(binDir, { recursive: true });
    const command = process.platform === 'win32'
      ? path.join(binDir, 'typescript-language-server.cmd')
      : path.join(binDir, 'typescript-language-server');
    await fs.writeFile(command, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');

    const servers = await autoDiscoverServers({}, root);

    expect(servers.typescript?.command).toBe(command);
  });

  it('keeps user configured servers instead of overwriting presets', async () => {
    const servers = await autoDiscoverServers({
      typescript: {
        command: 'custom-ts',
        languages: ['typescript'],
      },
    }, process.cwd());
    expect(servers.typescript?.command).toBe('custom-ts');
  });
});
