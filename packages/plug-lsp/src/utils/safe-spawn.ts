import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { ServerConfig } from '../types.js';
import { buildChildEnv } from '@wrongstack/core';

export function safeSpawn(cfg: ServerConfig, cwd: string): ChildProcessWithoutNullStreams {
  /* v8 ignore next -- platform-specific branch differs between Windows and POSIX. */
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cfg.command);
  return spawn(cfg.command, cfg.args ?? [], {
    cwd,
    env: buildChildEnv({ extra: cfg.env }),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell,
    windowsHide: true,
  });
}
