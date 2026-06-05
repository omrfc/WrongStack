/**
 * Free-port discovery for the standalone WebUI server.
 *
 * When a user runs several instances, the default ports (HTTP 3456 / WS 3457)
 * are taken by the first one. Rather than make the user hand-pick `PORT` /
 * `WS_PORT` for every extra instance, the server probes upward from the
 * requested port and binds the first free one — then stamps that real port into
 * the served HTML and the instance registry so everything stays consistent.
 *
 * The probe binds a throwaway `net.Server`, then closes it, so there is a tiny
 * TOCTOU window between "found free" and "the real server binds it". For local
 * single-user multi-instance use that race is negligible; if it ever loses, the
 * real bind fails loudly with EADDRINUSE exactly as before.
 */

import * as net from 'node:net';

/** Resolve true when `port` can be bound on `host`, false on EADDRINUSE/EACCES. */
export function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    try {
      srv.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

export interface FindFreePortOptions {
  /** Ports to skip even if free (e.g. one already chosen for the sibling server). */
  exclude?: Set<number>;
  /** How many consecutive ports to try before giving up. Default 200. */
  maxTries?: number;
}

/**
 * Find the first free port at or above `startPort` on `host`, skipping any in
 * `exclude`. Throws if nothing is free within `maxTries` steps.
 */
export async function findFreePort(
  host: string,
  startPort: number,
  opts: FindFreePortOptions = {},
): Promise<number> {
  const exclude = opts.exclude ?? new Set<number>();
  const maxTries = opts.maxTries ?? 200;
  let port = startPort;
  for (let i = 0; i < maxTries; i++) {
    // Stay inside the valid TCP range; wrap into the high ephemeral band if a
    // pathological startPort pushes us past the ceiling.
    if (port > 65535) port = 1024 + (port % 50000);
    if (!exclude.has(port) && (await isPortFree(host, port))) {
      return port;
    }
    port++;
  }
  throw new Error(
    `No free port found near ${startPort} on ${host} after ${maxTries} attempts.`,
  );
}
