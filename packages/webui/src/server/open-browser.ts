/**
 * Best-effort "open this URL in the default browser" for `--webui --open`.
 *
 * Cross-platform via the OS opener (`start` / `open` / `xdg-open`). Fully
 * fire-and-forget: a missing opener, a headless box, or a spawn failure must
 * NEVER take the server down — the URL is always also printed to the console.
 */

import { spawn } from 'node:child_process';

/** Resolve the platform's URL-opener command + args. */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    // `start` is a cmd builtin; the empty "" is the window title slot so URLs
    // containing `&` / spaces are passed through intact.
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/** Spawn the OS browser-opener for `url`. Never throws. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const { command, args } = browserOpenCommand(url, platform);
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // A missing opener (e.g. xdg-open absent on a headless box) surfaces as an
    // async 'error' event — swallow it so it doesn't crash the process.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Synchronous spawn failure — best-effort, ignore.
  }
}
