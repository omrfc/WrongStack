import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core';

export async function resolveServerCommand(command: string, cwd: string): Promise<string | null> {
  const local = await findLocalBinary(cwd, command);
  if (local) return local;
  return (await commandExistsOnPath(command)) ? command : null;
}

export async function findLocalBinary(cwd: string, command: string): Promise<string | null> {
  if (path.isAbsolute(command)) return (await fileExists(command)) ? path.normalize(command) : null;
  let dir = path.resolve(cwd);
  for (;;) {
    const binDir = path.join(dir, 'node_modules', '.bin');
    for (const candidate of commandCandidates(command)) {
      const full = path.join(binDir, candidate);
      if (await fileExists(full)) return full;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function commandExistsOnPath(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where.exe' : 'sh';
  const args =
    process.platform === 'win32' ? [command] : ['-lc', `command -v ${shellQuote(command)}`];
  return new Promise((resolve) => {
    const child = spawn(probe, args, { env: buildChildEnv(), stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function commandCandidates(command: string): string[] {
  /* v8 ignore next -- platform-specific branch; covered on non-Windows CI. */
  if (process.platform !== 'win32') return [command];
  const ext = path.extname(command).toLowerCase();
  if (ext) return [command];
  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command, `${command}.ps1`];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  /* v8 ignore next -- only used by POSIX command probing. */
  return `'${value.replace(/'/g, "'\\''")}'`;
}
