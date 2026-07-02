/**
 * Live session status poll for the CLI WebUI bridge.
 *
 * Periodically reads the cross-process SessionRegistry and pushes live
 * agent/session status to all connected WebSocket clients, so the WebUI
 * session panel stays in sync even when agents run in background (project
 * switches, multiple processes). Three triggers share one broadcaster:
 * a 5s fallback poll (which also prunes stale entries on read), a
 * debounced fs.watch on the registry file (~150ms after a TUI/REPL write),
 * and an immediate kick on startup. The broadcaster is also handed to the
 * caller for the `/api/fleet/ping` push-on-write HTTP route.
 *
 * PR 13 of Issue #30: extracted from `webui-server.ts`.
 */
import { watch as fsWatch } from 'node:fs';

export interface SessionStatusPollDeps {
  /** Directory holding session-registry.json (the wstack global root). */
  globalRoot: string;
  broadcast: (msg: { type: string; payload: unknown }) => void;
  /** Shared disposer list — poll interval + fs watcher land here. */
  eventUnsubscribers: Array<() => void>;
  /** Receives the broadcaster so `/api/fleet/ping` can push-on-write. */
  onBroadcastReady: (fn: () => Promise<void>) => void;
}

export function startSessionStatusPoll(deps: SessionStatusPollDeps): void {
  const { globalRoot, broadcast, eventUnsubscribers, onBroadcastReady } = deps;

  const broadcastSessions = async () => {
    try {
      // Lazy import to avoid bundling core into the webui runtime
      const { SessionRegistry } = await import('@wrongstack/core');
      const registry = new SessionRegistry(globalRoot);
      const sessions = await registry.list();
      // Scope Fleet HQ to our own project (derive from our pid's entry —
      // survives in-place project switches). Fall back to all if not found.
      const mySlug = sessions.find((s) => s.pid === process.pid)?.projectSlug;
      const live = sessions
        .filter((s) => s.status !== 'stale')
        .filter((s) => (mySlug ? s.projectSlug === mySlug : true))
        .map((s) => ({
          sessionId: s.sessionId,
          projectName: s.projectName,
          projectSlug: s.projectSlug,
          projectRoot: s.projectRoot,
          workingDir: s.workingDir,
          gitBranch: s.gitBranch,
          clientType: s.clientType,
          status: s.status,
          pid: s.pid,
          startedAt: s.startedAt,
          agentCount: s.agentCount,
          agents: s.agents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            currentTool: a.currentTool,
            iterations: a.iterations,
            toolCalls: a.toolCalls,
            costUsd: a.costUsd,
            tokensIn: a.tokensIn,
            tokensOut: a.tokensOut,
            ctxPct: a.ctxPct,
            model: a.model,
            partialText: a.partialText,
            lastActivityAt: a.lastActivityAt,
          })),
        }));
      broadcast({ type: 'sessions.status_update', payload: { sessions: live } });
    } catch {
      // Best-effort — never crash the WebSocket relay for status errors
    }
  };
  // Expose to the /api/fleet/ping HTTP route (push-on-write).
  onBroadcastReady(broadcastSessions);

  // Fallback poll (also prunes stale entries on read).
  const statusInterval = setInterval(() => void broadcastSessions(), 5_000);
  if (statusInterval.unref) statusInterval.unref();
  eventUnsubscribers.push(() => clearInterval(statusInterval));

  // Event-driven: watch the registry file so a TUI/REPL write reaches the
  // map in ~150ms. Atomic writes go `<file>.<uuid>.tmp`→rename → watch the
  // dir and match any `session-registry.json*` change (ignore .lock).
  let regDebounce: ReturnType<typeof setTimeout> | undefined;
  try {
    const regWatcher = fsWatch(globalRoot, { persistent: false }, (_event, filename) => {
      const name = filename ? String(filename) : '';
      if (!name.startsWith('session-registry.json') || name.endsWith('.lock')) return;
      if (regDebounce) clearTimeout(regDebounce);
      regDebounce = setTimeout(() => void broadcastSessions(), 150);
    });
    eventUnsubscribers.push(() => {
      if (regDebounce) clearTimeout(regDebounce);
      regWatcher.close();
    });
  } catch {
    // Watch unsupported on this platform — the 5s poll still covers it.
  }

  void broadcastSessions();
}
