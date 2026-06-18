import type { EventBus, Context, SessionEventBridge, WstackPaths } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { ConnectedClient, WSServerMessage } from './types.js';

import * as fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import * as path from 'node:path';

/** Metrics for the file watcher that watches status.json files. */
export interface FileWatcherMetrics {
  fileChangesDetected: number;
  filesProcessed: number;
  broadcastsSent: number;
  debounceResets: number;
  totalDebounceDelayMs: number;
  activeProjects: number;
  /** Average debounce delay in ms across all broadcasts. */
  averageDebounceDelayMs: number;
  /** Whether the file watcher is currently active. */
  watcherActive: boolean;
}

export interface SetupEventsDeps {
  events: EventBus;
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
  clients: Map<WebSocket, ConnectedClient>;
  config: { tools?: { maxIterations?: number | undefined } };
  context: Context;
  pendingConfirms: Map<string, (d: 'yes' | 'no' | 'always' | 'deny') => void>;
  /** Optional global config dir (~/.wrongstack) — enables SessionRegistry poll for fleet view. */
  globalConfigPath?: string | undefined;
  /**
   * Audit-level-aware session log bridge. When provided, tool/error/provider
   * events are persisted to the session JSONL (same contract as the CLI) —
   * without it, standalone-WebUI sessions carry no audit events and resume
   * with no tool history.
   */
  sessionBridge?: SessionEventBridge | undefined;
  /** Optional wpaths for writing status.json file. */
  wpaths?: WstackPaths | undefined;
  /**
   * Optional object to populate with file watcher metrics.
   * When provided, the setupEvents function will populate this object
   * with real-time metrics from the file watcher.
   */
  watcherMetrics?: FileWatcherMetrics | undefined;
  /**
   * Receives the internal `broadcastSessions` fn so the HTTP layer can trigger
   * an immediate fleet re-broadcast on `POST /api/fleet/ping` (push-on-write
   * from a TUI/REPL), instead of waiting on the registry file-watch/poll.
   */
  onFleetBroadcaster?: ((fn: () => Promise<void>) => void) | undefined;
}

/**
 * Wire kernel events to WS broadcasts and (when wpaths/globalConfigPath are
 * given) start the status-file watcher and session-poll interval.
 *
 * Returns a disposer that stops the watcher, clears the metrics/poll
 * intervals, and flushes pending debounce timers. Callers MUST invoke it on
 * shutdown — the watcher is `persistent: true` and the metrics interval is not
 * `unref`'d, so without disposal they keep the process alive and leak across
 * server restarts. (Previously this was hung off a non-existent
 * `process.on('cleanup')` event that never fired.)
 */
export function setupEvents(deps: SetupEventsDeps): () => void {
  const { events, broadcast, clients, config, context, pendingConfirms, globalConfigPath, sessionBridge, wpaths, watcherMetrics, onFleetBroadcaster } = deps;
  const disposers: Array<() => void> = [];

  events.on('iteration.started', (e) => {
    // Read maxIterations from context.meta so the UI reflects the
    // webui setting, falling back to the startup config default.
    const maxIt = typeof context.meta['maxIterations'] === 'number'
      ? context.meta['maxIterations']
      : config.tools?.maxIterations ?? 100;
    broadcast(clients, {
      type: 'iteration.started',
      payload: { index: e.index, maxIterations: maxIt },
    });
  });

  events.on('provider.text_delta', (e) => {
    broadcast(clients, { type: 'provider.text_delta', payload: { text: e.text, messageId: 'current' } });
  });

  events.on('provider.thinking_delta', (e) => {
    broadcast(clients, { type: 'provider.thinking_delta', payload: { text: e.text } });
  });

  events.on('tool.started', (e) => {
    broadcast(clients, {
      type: 'tool.started',
      payload: { id: e.id, name: e.name, input: e.input, messageId: `tool_${e.id}` },
    });
    // Persist for audit + resume tool history (respects auditLevel).
    sessionBridge
      ?.append({
        type: 'tool_call_start',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id,
        input: e.input,
      })
      .catch(() => { /* best-effort */ });
  });

  events.on('tool.progress', (e) => {
    broadcast(clients, {
      type: 'tool.progress',
      // Nested `event` shape — the client handler reads `payload.event?.text`
      // and early-returns on a falsy text, so a flat { eventType, text } payload
      // makes live tool progress (bash streaming, partial_output, warnings)
      // never render. Must match WSToolProgress and the CLI server.
      payload: { id: e.id, name: e.name, event: { type: e.event.type, text: e.event.text, data: e.event.data } },
    });
    sessionBridge
      ?.append({
        type: 'tool_progress',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id,
        event: { type: e.event.type, text: e.event.text, data: e.event.data },
      })
      .catch(() => { /* best-effort */ });
  });

  events.on('tool.executed', (e) => {
    broadcast(clients, {
      type: 'tool.executed',
      payload: { id: e.id, name: e.name, durationMs: e.durationMs, ok: e.ok, input: e.input, output: e.output },
    });
    sessionBridge
      ?.append({
        type: 'tool_call_end',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id ?? '',
        durationMs: e.durationMs,
        outputSize: e.outputBytes ?? 0,
        ok: e.ok,
        outputBytes: e.outputBytes,
        outputTokens: e.outputTokens,
        outputLines: e.outputLines,
      })
      .catch(() => { /* best-effort */ });
    broadcast(clients, { type: 'todos.updated', payload: { todos: [...context.todos] } });

    // Broadcast task/plan updates after task/plan/todo tool executions.
    if (e.name === 'task' || e.name === 'plan' || e.name === 'todo') {
      void (async () => {
        try {
          const taskPath = (context.meta as Record<string, unknown>)['task.path'];
          if (typeof taskPath === 'string' && taskPath) {
            const { loadTasks } = await import('@wrongstack/core');
            const file = await loadTasks(taskPath);
            broadcast(clients, { type: 'tasks.updated', payload: { tasks: file?.tasks ?? [] } });
          }
        } catch { /* best-effort */ }
        try {
          const planPath = (context.meta as Record<string, unknown>)['plan.path'];
          if (typeof planPath === 'string' && planPath) {
            const { loadPlan } = await import('@wrongstack/core');
            const plan = await loadPlan(planPath);
            broadcast(clients, { type: 'plan.updated', payload: { plan: plan ?? { version: 1, sessionId: context.session?.id ?? '', updatedAt: new Date().toISOString(), items: [] } } });
          }
        } catch { /* best-effort */ }
      })();
    }
  });

  events.on('provider.response', (e) => {
    broadcast(clients, { type: 'provider.response', payload: { usage: e.usage, stopReason: e.stopReason, messageId: 'current' } });
  });

  events.on('context.repaired', (e) => {
    broadcast(clients, { type: 'context.repaired', payload: { removedToolUses: e.removedToolUses, removedToolResults: e.removedToolResults, removedMessages: e.removedMessages } });
  });

  events.on('tool.confirm_needed', (e) => {
    const id = e.toolUseId ?? `confirm_${Date.now()}`;
    pendingConfirms.set(id, e.resolve);
    broadcast(clients, { type: 'tool.confirm_needed', payload: { id, toolName: e.tool?.name ?? 'unknown', input: e.input, suggestedPattern: e.suggestedPattern } });
  });

  events.on('error', (e) => {
    broadcast(clients, { type: 'error', payload: { phase: e.phase, message: e.err instanceof Error ? e.err.message : String(e.err) } });
    sessionBridge
      ?.append({
        type: 'error',
        ts: new Date().toISOString(),
        message: e.err instanceof Error ? e.err.message : String(e.err),
        phase: e.phase,
      })
      .catch(() => { /* best-effort */ });
  });

  // Provider visibility — retry storms and provider failures in the JSONL
  // for forensics, mirroring the CLI's bridge wiring.
  events.on('provider.retry', (e) => {
    sessionBridge
      ?.append({
        type: 'provider_retry',
        ts: new Date().toISOString(),
        providerId: e.providerId,
        attempt: e.attempt,
        delayMs: e.delayMs,
        status: e.status,
        description: e.description,
      })
      .catch(() => { /* best-effort */ });
  });

  events.on('provider.error', (e) => {
    sessionBridge
      ?.append({
        type: 'provider_error',
        ts: new Date().toISOString(),
        providerId: e.providerId,
        status: e.status,
        description: e.description,
        retryable: e.retryable,
      })
      .catch(() => { /* best-effort */ });
  });

  // ── Inter-agent mailbox visibility ───────────────────────────────────
  // Forward cross-session mailbox activity (messages received by this
  // process's agents, new agent registrations on the project) to the
  // browser so the user sees multi-terminal/multi-surface chatter live.
  // These events are emitted via emit() with untyped names (GlobalMailbox
  // + mailbox-loop), so subscribe by pattern like the TUI does.
  events.onPattern('mailbox.received', (_e, payload) => {
    broadcast(clients, { type: 'mailbox.received', payload } as unknown as WSServerMessage);
  });
  events.onPattern('mailbox.agent_registered', (_e, payload) => {
    broadcast(clients, { type: 'mailbox.agent_registered', payload } as unknown as WSServerMessage);
  });

  // Subagent fleet lifecycle
  const forwardSubagent = (kind: string, payload: Record<string, unknown>) =>
    broadcast(clients, { type: 'subagent.event', payload: { kind, sessionId: context.session.id, ...payload } });

  events.on('subagent.spawned', (e) => forwardSubagent('spawned', { subagentId: e.subagentId, taskId: e.taskId, name: e.name, provider: e.provider, model: e.model, description: e.description }));
  events.on('subagent.task_started', (e) => forwardSubagent('task_started', { subagentId: e.subagentId, taskId: e.taskId, description: e.description }));
  events.on('subagent.tool_executed', (e) => forwardSubagent('tool_executed', { subagentId: e.subagentId, toolName: e.name, durationMs: e.durationMs, ok: e.ok }));
  events.on('subagent.iteration_summary', (e) => forwardSubagent('iteration_summary', { subagentId: e.subagentId, iteration: e.iteration, toolCalls: e.toolCalls, costUsd: e.costUsd, currentTool: e.currentTool, partialText: e.partialText }));
  events.on('subagent.budget_extended', (e) => forwardSubagent('budget_extended', { subagentId: e.subagentId, totalExtensions: e.totalExtensions }));
  events.on('subagent.ctx_pct', (e) => forwardSubagent('ctx_pct', { subagentId: e.subagentId, load: e.load, tokens: e.tokens, maxContext: e.maxContext }));
  events.on('subagent.task_completed', (e) => forwardSubagent('task_completed', { subagentId: e.subagentId, status: e.status, iterations: e.iterations, toolCalls: e.toolCalls, finalText: (e as Record<string, unknown>).finalText as string | undefined, error: e.error ? { kind: e.error.kind, message: e.error.message } : undefined }));

  // ── Leader (main session) events — forwarded as subagent.event with subagentId 'leader' ──
  // These give the AgentsPage a live leader row with real-time tool tracking,
  // context pressure — matching the TUI's leader entry.
  // Iteration counts, cost, and overall status come from the sessionStore on the frontend.

  // Leader spawned: sent on first iteration so the frontend creates the leader row.
  let leaderSpawned = false;
  events.on('iteration.started', () => {
    if (!leaderSpawned) {
      leaderSpawned = true;
      const provider = (context.provider as { id?: string } | undefined)?.id ?? 'unknown';
      forwardSubagent('spawned', {
        subagentId: 'leader',
        name: 'LEADER',
        provider,
        model: context.model,
        description: `Main agent session (${context.session.id})`,
      });
    }
  });

  // Leader tool execution: emitted on every tool.executed in the main session.
  events.on('tool.executed', (e) => {
    forwardSubagent('tool_executed', {
      subagentId: 'leader',
      toolName: e.name,
      durationMs: e.durationMs,
      ok: e.ok,
    });
  });

  // Leader context pressure + cost: emitted on every provider response.
  events.on('provider.response', (e) => {
    if (e.usage?.input != null) {
      const maxCtx = context.provider.capabilities.maxContext;
      const pct = maxCtx > 0 ? e.usage.input / maxCtx : 0;
      const costUsd = context.tokenCounter.estimateCost().total;
      forwardSubagent('ctx_pct', {
        subagentId: 'leader',
        load: pct,
        tokens: e.usage.input,
        maxContext: maxCtx,
        costUsd,
      });
    }
  });

  // Leader iteration updates: we already track iteration started above.
  // The frontend uses sessionStore for accurate cost/iteration counts.
  // When the run completes, the frontend's run.result handler resets isLoading,
  // making the leader go idle. We reset leader state on iteration.started.
  events.on('iteration.completed', () => {
    // Respawn leader if it was cleared (e.g., on session resume).
    if (!leaderSpawned) {
      leaderSpawned = true;
      const provider = (context.provider as { id?: string } | undefined)?.id ?? 'unknown';
      forwardSubagent('spawned', {
        subagentId: 'leader',
        name: 'LEADER',
        provider,
        model: context.model,
        description: `Main agent session (${context.session.id})`,
      });
    }
  });

  // ── Mailbox events — broadcast to WebUI for real-time per-project visibility ──
  events.onPattern('mailbox.*', (eventName, payload) => {
    broadcast(clients, { type: 'mailbox.event', payload: { event: eventName, ...payload as Record<string, unknown> } });
  });

  // ── Brain events — decisions + proactive interventions, live in the browser ──
  events.onPattern('brain.*', (eventName, payload) => {
    broadcast(clients, { type: 'brain.event', payload: { event: eventName, ...payload as Record<string, unknown> } } as unknown as WSServerMessage);
  });

  // ── Client status events — immediate broadcast to WebUI + write to status.json ──
  // Emitted by TUI/CLI/WebUI when significant status changes occur (tool calls, tokens, etc.)
  events.on('client.status', async (e) => {
    // Immediately broadcast to all connected WebUI clients
    broadcast(clients, { type: 'client.status_update', payload: e });

    // Write to status.json file for external watchers (e.g., other tools monitoring this project)
    if (wpaths?.projectStatus) {
      try {
        const statusFile = wpaths.projectStatus(e.projectHash);
        const dir = path.dirname(statusFile);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(statusFile, JSON.stringify(e, null, 2), 'utf-8');
      } catch (err) {
        console.error('[setup-events] Failed to write status.json:', err);
      }
    }
  });

  // ── File watcher for external status.json changes ──
  // Watches ~/.wrongstack/projects/<hash>/status.json files for external tool changes.
  // Uses project hash filtering and debouncing to handle rapid writes efficiently.
  if (wpaths?.projectStatus && wpaths.configDir) {
    // projectsDir = ~/.wrongstack/projects/
    const projectsDir = path.join(wpaths.configDir, 'projects');

    // Track known project hashes (populated from incoming client.status events)
    const knownProjectHashes = new Set<string>();

    // Debounce state: map of projectHash -> timer
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const DEBOUNCE_MS = 150; // Wait 150ms after last write before broadcasting

    // Track pending status updates for debouncing (with write timestamps for delay calculation)
    const pendingStatuses = new Map<string, { data: unknown; firstWriteAt: number }>();

    // Initialize the external watcher metrics object if provided
    if (watcherMetrics) {
      watcherMetrics.fileChangesDetected = 0;
      watcherMetrics.filesProcessed = 0;
      watcherMetrics.broadcastsSent = 0;
      watcherMetrics.debounceResets = 0;
      watcherMetrics.totalDebounceDelayMs = 0;
      watcherMetrics.activeProjects = 0;
      watcherMetrics.averageDebounceDelayMs = 0;
      watcherMetrics.watcherActive = true;
    }

    const getAverageDebounceDelay = (): number => {
      if (!watcherMetrics || watcherMetrics.broadcastsSent === 0) return 0;
      return watcherMetrics.totalDebounceDelayMs / watcherMetrics.broadcastsSent;
    };

    const logWatcherMetrics = () => {
      if (!watcherMetrics) return;
      // Update computed field
      watcherMetrics.averageDebounceDelayMs = getAverageDebounceDelay();
      console.log(
        `[setup-events] File watcher stats: ` +
        `${watcherMetrics.broadcastsSent} broadcasts, ` +
        `${watcherMetrics.fileChangesDetected} file changes, ` +
        `${watcherMetrics.debounceResets} debounce resets, ` +
        `avg delay: ${watcherMetrics.averageDebounceDelayMs.toFixed(1)}ms, ` +
        `${watcherMetrics.activeProjects} active projects`
      );
    };

    // Log metrics every 60 seconds
    const metricsInterval = setInterval(logWatcherMetrics, 60_000);

    const broadcastStatus = (projectHash: string, statusData: unknown, actualDelayMs: number) => {
      broadcast(clients, { type: 'client.status_update', payload: statusData });
      if (watcherMetrics) {
        watcherMetrics.broadcastsSent++;
        watcherMetrics.totalDebounceDelayMs += actualDelayMs;
        watcherMetrics.averageDebounceDelayMs = getAverageDebounceDelay();
      }
    };

    const scheduleBroadcast = (projectHash: string, statusData: unknown) => {
      const now = Date.now();
      const existing = pendingStatuses.get(projectHash);

      // Track if this is a debounce reset (rapid successive write)
      if (existing && watcherMetrics) {
        watcherMetrics.debounceResets++;
      }

      // Store latest status data with first write timestamp
      pendingStatuses.set(projectHash, {
        data: statusData,
        firstWriteAt: existing ? existing.firstWriteAt : now,
      });

      // Clear existing timer for this project
      const existingTimer = debounceTimers.get(projectHash);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new debounce timer
      const timer = setTimeout(() => {
        debounceTimers.delete(projectHash);
        const pending = pendingStatuses.get(projectHash);
        if (pending) {
          const actualDelay = Date.now() - pending.firstWriteAt;
          broadcastStatus(projectHash, pending.data, actualDelay);
          pendingStatuses.delete(projectHash);
        }
      }, DEBOUNCE_MS);

      debounceTimers.set(projectHash, timer);
    };

    let watcher: import('fs').FSWatcher | undefined;

    const startWatcher = async () => {
      try {
        // Ensure directory exists before watching
        await fs.mkdir(projectsDir, { recursive: true });

        // Use fs.watch for efficient file change detection
        // Watch the projects directory for changes to status.json files
        // recursive:true so nested `<hash>/status.json` writes are delivered —
        // a non-recursive watch on the parent dir does not reliably fire for
        // changes inside subdirectories. filename can be null on some platforms.
        watcher = fsWatch(projectsDir, { persistent: true, recursive: true }, async (eventType, filename) => {
          if (eventType === 'change') {
            if (filename == null) return;
            if (watcherMetrics) watcherMetrics.fileChangesDetected++;

            // filename is the path relative to projectsDir, e.g. '<hash>/status.json'
            const targetFile = path.join(projectsDir, String(filename));
            if (targetFile.endsWith('status.json')) {
              // Extract project hash from path: .../projects/<hash>/status.json
              const projectHash = path.basename(path.dirname(targetFile));

              // Only process if this is a known project hash
              if (knownProjectHashes.size > 0 && !knownProjectHashes.has(projectHash)) {
                return; // Skip unknown project directories
              }

              if (watcherMetrics) watcherMetrics.filesProcessed++;

              try {
                const content = await fs.readFile(targetFile, 'utf-8');
                const statusData = JSON.parse(content);

                // Add to known hashes if not present
                if (statusData.projectHash) {
                  const hash = String(statusData.projectHash);
                  if (!knownProjectHashes.has(hash)) {
                    knownProjectHashes.add(hash);
                    if (watcherMetrics) watcherMetrics.activeProjects = knownProjectHashes.size;
                  }
                }

                // Debounce the broadcast
                scheduleBroadcast(projectHash, statusData);
              } catch {
                // File may not exist, be readable yet, or invalid JSON
              }
            }
          }
        });

        console.log(`[setup-events] Watching ${projectsDir} for status.json changes (hash-filtered, debounced)`);
      } catch (err) {
        console.error('[setup-events] Failed to start status file watcher:', err);
      }
    };

    // Register incoming client.status events to build known project hashes
    // This ensures we only watch directories that have emitted status before
    events.on('client.status', (e) => {
      if (e.projectHash) {
        const hash = String(e.projectHash);
        if (!knownProjectHashes.has(hash)) {
          knownProjectHashes.add(hash);
          if (watcherMetrics) watcherMetrics.activeProjects = knownProjectHashes.size;
        }
      }
    });

    // Start watcher asynchronously without blocking setup
    startWatcher();

    // Clean up watcher and timers on shutdown. Registered as a disposer so it
    // actually runs (the previous `process.on('cleanup')` event never fires).
    disposers.push(() => {
      clearInterval(metricsInterval);
      logWatcherMetrics(); // Final metrics log on shutdown

      // Mark watcher as inactive
      if (watcherMetrics) watcherMetrics.watcherActive = false;

      // Flush any pending broadcasts before cleanup
      for (const [projectHash, pending] of pendingStatuses) {
        const timer = debounceTimers.get(projectHash);
        if (timer) {
          clearTimeout(timer);
          // Broadcast pending status immediately on shutdown
          broadcastStatus(projectHash, pending.data, 0);
        }
      }

      // Clear all debounce timers
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      pendingStatuses.clear();

      if (watcher) {
        watcher.close();
        console.log('[setup-events] Closed status file watcher');
      }
    });
  }

  // ── Cross-process session / fleet status ──
  // Read the SessionRegistry and broadcast live session+agent status to all
  // connected clients. Three triggers, from fastest to slowest: a push-on-write
  // `POST /api/fleet/ping` (via onFleetBroadcaster, ~ms), an `fs.watch` on the
  // registry file (~150ms), and a 5s fallback poll that also prunes stale
  // entries via `list()`.
  const globalRoot = globalConfigPath ? path.dirname(globalConfigPath) : undefined;
  if (globalRoot) {
    const broadcastSessions = async () => {
      try {
        const { SessionRegistry } = await import('@wrongstack/core');
        const registry = new SessionRegistry(globalRoot);
        const sessions = await registry.list();
        // Scope Fleet HQ to the *same project* as this server. The registry lists
        // every project's sessions, so derive our current project from our own
        // entry (matched by pid — survives in-place project switches, unlike the
        // launch-time `wpaths.projectSlug`). Fall back to all sessions if our
        // entry isn't found yet (first tick before registration settles).
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
            // Surface (tui/webui/cli) so Fleet HQ can label each live client node.
            clientType: s.clientType,
            status: s.status,
            pid: s.pid,
            startedAt: s.startedAt,
            agentCount: s.agentCount,
            agents: (s.agents ?? []).map((a) => ({
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
              lastActivityAt: a.lastActivityAt,
            })),
          }));
        broadcast(clients, { type: 'sessions.status_update', payload: { sessions: live } });
      } catch {
        // Best-effort — never crash for status broadcasting errors
      }
    };

    // Hand the broadcaster to the HTTP layer for push-on-write (/api/fleet/ping).
    onFleetBroadcaster?.(broadcastSessions);

    // Fallback poll (also prunes stale entries on read).
    const statusInterval = setInterval(() => void broadcastSessions(), 5_000);
    if (statusInterval.unref) statusInterval.unref();
    disposers.push(() => clearInterval(statusInterval));

    // Event-driven: watch the registry file so a TUI/REPL agent's write reaches
    // the map in ~150ms. Atomic writes go via `<file>.<uuid>.tmp` → rename, so
    // watch the dir and match any `session-registry.json*` change (ignore .lock).
    let regDebounce: ReturnType<typeof setTimeout> | undefined;
    try {
      const regWatcher = fsWatch(globalRoot, { persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : '';
        if (!name.startsWith('session-registry.json') || name.endsWith('.lock')) return;
        if (regDebounce) clearTimeout(regDebounce);
        regDebounce = setTimeout(() => void broadcastSessions(), 150);
      });
      disposers.push(() => {
        if (regDebounce) clearTimeout(regDebounce);
        regWatcher.close();
      });
    } catch {
      // Watch unsupported on this platform — the 5s poll still covers it.
    }

    // Push an immediate snapshot so a freshly-connected client doesn't wait.
    void broadcastSessions();
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* best-effort teardown */
      }
    }
  };
}
