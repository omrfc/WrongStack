#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(packageRoot, 'dist', 'main', 'main.js');

if (!existsSync(mainEntry)) {
  console.error(
    [
      'WrongStack Desktop is not built.',
      '',
      'From the repository, run:',
      '  pnpm --filter @wrongstack/desktop build',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const child = spawn(electron, [packageRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false,
});

child.once('error', (err) => {
  console.error(`Failed to start WrongStack Desktop: ${err.message}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
});
