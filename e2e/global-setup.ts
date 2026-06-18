import type { FullConfig } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Starts the WrongStack CLI in webui mode and waits for the HTTP server
 * to be ready before running tests. The server process is killed when all
 * tests complete.
 *
 * Environment variables:
 *   WEBUI_URL   — base URL of an already-running server (skip startup)
 *   CLI_PATH     — path to the CLI binary (default: packages/cli/dist/index.js)
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = process.env.WEBUI_URL;

  if (baseURL) {
    // External server — verify it is up.
    const ok = await waitForUrl(baseURL, 10_000);
    if (!ok) throw new Error(`WEBUI_URL=${baseURL} is not reachable`);
    return;
  }

  // Start the CLI in webui mode.
  const cliPath = process.env.CLI_PATH ?? 'packages/cli/dist/index.js';
  const server = spawn('node', [cliPath, '--webui'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0' }, // PORT=0 = auto-assign
  });

  // Capture server output for debugging.
  server.stdout?.on('data', (chunk) =>
    process.stdout.write(`[webui:stdout] ${chunk}`),
  );
  server.stderr?.on('data', (chunk) =>
    process.stderr.write(`[webui:stderr] ${chunk}`),
  );

  // Wait for the HTTP server URL to appear in stdout.
  const url = await waitForServerOutput(server, 60_000);
  if (!url) {
    server.kill();
    throw new Error('WebUI server failed to start within 60s');
  }

  // Give the WebSocket port a moment to stabilise.
  await sleep(500);

  // Store the HTTP URL so tests use it as baseURL.
  process.env.WEBUI_URL = url;
  (config as FullConfig & { _serverProcess: typeof server })._serverProcess = server;
}

/** Poll stdout until we see a "running on http://..." line. */
async function waitForServerOutput(
  server: ReturnType<typeof spawn>,
  timeout: number,
): Promise<string | null> {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    function handler(chunk: Buffer) {
      const line = chunk.toString();
      // Match HTTP server URL (ws:// is the WS server, not what browser uses for HTTP).
      // Handles both "localhost" (Windows console) and "127.0.0.1".
      const match = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
      if (match) {
        const port = match[1]!;
        const url = `http://127.0.0.1:${port}`;
        server.stdout?.off('data', handler);
        resolve(url);
      } else if (Date.now() > deadline) {
        server.stdout?.off('data', handler);
        resolve(null);
      }
    }
    server.stdout?.on('data', handler);
  });
}

/** Verify a URL responds with HTTP 200. */
async function waitForUrl(url: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  return false;
}
