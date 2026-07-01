/**
 * --hq short-circuit — extracted from cli-main.ts.
 *
 * Starts the HQ command center server before boot() — HQ is
 * project-independent. Blocks until SIGINT/SIGTERM.
 *
 * Returns 0 when the HQ flag was present and the server ran, or null
 * when the flag was absent (caller should proceed to boot()).
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { color, resolveHqDataDir } from '@wrongstack/core';
import { DEFAULT_PORT } from '../hq-server.js';

interface HqRuntimeMarker {
  url?: string;
  pid?: number;
  updatedAt?: string;
}

/**
 * Returns true if there is an HQ server already running for this data dir
 * (runtime.json exists and its PID is still alive).
 */
async function isHqAlreadyRunning(dataDir: string): Promise<HqRuntimeMarker | null> {
  const markerPath = path.join(dataDir, 'runtime.json');
  let fd;
  try {
    fd = await fs.open(markerPath, 'r');
    const content = await fd.read().then(({ buffer }) => buffer.toString('utf8'));
    const marker = JSON.parse(content) as HqRuntimeMarker;
    if (marker.pid) {
      try {
        // Signal 0 checks if the process exists without sending anything.
        process.kill(marker.pid, 0);
        return marker; // PID is alive
      } catch {
        // PID is dead — stale marker, ignore.
      }
    }
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  } finally {
    if (fd) await fd.close();
  }
}

/**
 * Returns true if the port is already in use on the given host.
 */
async function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, host);
  });
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

  // Port: use --port flag if explicitly given; otherwise use the documented
  // default without prompting so `wstack --hq` and `wstack hq` are direct
  // launch commands.
  let port: number;
  if (typeof flags['port'] === 'string' && flags['port'].trim() !== '') {
    const parsed = Number.parseInt(flags['port'], 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    } else {
      process.stderr.write(`${color.red('✗')} Invalid --port value: ${flags['port']}\n`);
      return 1;
    }
  } else port = DEFAULT_PORT;

  const dataDir = typeof flags['data-dir'] === 'string' ? flags['data-dir'] : undefined;
  // User explicitly chose a port if they either passed --port OR accepted
  // a non-default value from the interactive prompt.
  const userProvidedPort =
    (typeof flags['port'] === 'string' && flags['port'].trim() !== '') ||
    port !== DEFAULT_PORT;

  // Resolve data dir the same way startHqServer does so we can check for a
  // running HQ instance before attempting to start a new one.
  const resolvedDataDir = dataDir ?? resolveHqDataDir();
  const existing = await isHqAlreadyRunning(resolvedDataDir);
  if (existing) {
    process.stderr.write(
      `${color.red('✗')} HQ is already running at ${existing.url} ` +
        `(PID ${existing.pid}). Stop it first or use a different --data-dir.\n`,
    );
    return 1;
  }

  // Probe the port before binding — fail fast with a clear message.
  if (await isPortInUse(host, port)) {
    process.stderr.write(
      `${color.red('✗')} Port ${port} is already in use. ` +
        `Choose a different port or stop the process using it.\n`,
    );
    return 1;
  }

  let handle;
  try {
    handle = await startHqServer({
      host,
      port,
      strictPort: flags['strict-port'] === true,
      exactPort: userProvidedPort,
      ...(dataDir !== undefined ? { dataDir } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && 'code' in err && err.code === 'EADDRINUSE') {
      process.stderr.write(`${color.red('✗')} Port ${port} is already in use. Please choose a different port.\n`);
    } else {
      process.stderr.write(`${color.red('✗')} Failed to start HQ server: ${msg}\n`);
    }
    return 1;
  }
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
    const shutdown = async () => {
      try {
        await handle.close();
      } catch (err) {
        console.error(`HQ server close error: ${String(err)}`);
      }
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}
