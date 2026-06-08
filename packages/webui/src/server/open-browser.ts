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

/** Spawn the OS browser-opener for `url` and register it as a protected
 *  process so it survives kill/killAll. Never throws. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const { command, args } = browserOpenCommand(url, platform);
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // A missing opener (e.g. xdg-open absent on a headless box) surfaces as an
    // async 'error' event — swallow it so it doesn't crash the process.
    child.on('error', () => {});
    child.unref();

    // Register the browser process as protected so process.kill / killAll
    // never accidentally terminates it — that would crash the webui session.
    // The registry is imported lazily to avoid a circular dependency with
    // @wrongstack/tools (which the webui server does not directly depend on).
    if (child.pid) {
      try {
        // Dynamic import to avoid hard dependency on @wrongstack/tools from
        // this module (the webui server may not have tools installed).
        import('@wrongstack/tools').then(({ getProcessRegistry }) => {
          getProcessRegistry().register({
            // biome-ignore lint/style/noNonNullAssertion: pid always present after spawn
            pid: child.pid!,
            name: 'browser',
            command: `${command} ${args.join(' ')}`,
            startedAt: Date.now(),
            child,
            protected: true,
          });
          // Auto-unregister on exit so the process list stays accurate.
          child.on('exit', () => {
            // biome-ignore lint/style/noNonNullAssertion: pid guaranteed after spawn
            getProcessRegistry().unregister(child.pid!);
          });
        }).catch(() => {
          // @wrongstack/tools may not be available — silently skip registration.
        });
      } catch {
        // Module resolution failure — silently skip.
      }
    }
  } catch {
    // Synchronous spawn failure — best-effort, ignore.
  }
}
