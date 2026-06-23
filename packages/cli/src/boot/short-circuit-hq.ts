/**
 * --hq short-circuit — extracted from cli-main.ts.
 *
 * Starts the HQ command center server before boot() — HQ is
 * project-independent. Blocks until SIGINT/SIGTERM.
 *
 * Returns 0 when the HQ flag was present and the server ran, or null
 * when the flag was absent (caller should proceed to boot()).
 */

import * as readline from 'node:readline';
import { color } from '@wrongstack/core';
import { DEFAULT_PORT } from '../hq-server.js';

/**
 * Ask the user for a port, accepting Enter to use the default.
 * Returns the chosen port number.
 */
async function promptPort(defaultPort: number): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(
        `  ${color.cyan('?')} HQ server port ${color.dim(`[${defaultPort}]`)}: `,
        resolve,
      );
    });
    const trimmed = answer.trim();
    if (trimmed === '') return defaultPort;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) return parsed;
    // Invalid input — retry
    process.stdout.write(`${color.red('✗')} Invalid port. Must be 1–65535.\n`);
    return promptPort(defaultPort);
  } finally {
    rl.close();
  }
}

/**
 * Check for --hq flag and start the HQ server if present.
 *
 * Returns 0 when the server started, or null when --hq was not set.
 */
export async function handleHqShortCircuit(
  flags: Record<string, string | boolean>,
): Promise<number | null> {
  if (flags['hq'] !== true) return null;

  const { startHqServer } = await import('../hq-server.js');
  const host = typeof flags['host'] === 'string' ? flags['host'] : '127.0.0.1';

  // Port: use --port flag if explicitly given, otherwise prompt interactively.
  let port: number;
  if (typeof flags['port'] === 'string' && flags['port'].trim() !== '') {
    const parsed = Number.parseInt(flags['port'], 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    } else {
      process.stderr.write(`${color.red('✗')} Invalid --port value: ${flags['port']}\n`);
      return 1;
    }
  } else {
    port = await promptPort(DEFAULT_PORT);
  }

  const dataDir = typeof flags['data-dir'] === 'string' ? flags['data-dir'] : undefined;
  const handle = await startHqServer({
    host,
    port,
    strictPort: flags['strict-port'] === true,
    ...(dataDir !== undefined ? { dataDir } : {}),
  });
  if (flags['open'] === true) {
    try {
      const { openBrowser } = await import('@wrongstack/webui/server');
      openBrowser(handle.firstRunSetup?.browserUrl ?? `http://${handle.host}:${handle.port}`);
    } catch {
      // best-effort
    }
  }
  // Keep the process alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void handle.close().then(() => resolve());
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}
