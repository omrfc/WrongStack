/**
 * Event arming for the CLI WebUI bridge — every EventBus subscription that
 * fans agent/fleet/tool/mailbox/brain activity out to connected browsers.
 *
 * `createSetupEvents(deps)` returns the `setupEvents()` function the server
 * calls on `listening` (and again after a project switch): it clears the
 * shared `eventUnsubscribers` list and re-arms every subscription, pushing
 * each disposer back onto that list so teardown/re-arm stays centralized in
 * the caller. Fleet-concurrency gauge state lives here too — it is only ever
 * read and mutated by these subscriptions.
 *
 * PR 12 of Issue #30: extracted from `webui-server.ts`.
 */
import type { Context, EventBus, JournalEntry, SecretScrubber } from '@wrongstack/core';
import { createEternalSubscription } from '@wrongstack/webui/server';
import type { StreamCoalescer } from './stream-coalescer.js';
import type { PendingConfirm } from './ws-handlers/index.js';

export interface SetupEventsDeps {
  events: EventBus;
  agent: { ctx: Context };
  subscribeEternalIteration?:
    | ((fn: (entry: JournalEntry) => void) => () => void)
    | undefined;
  broadcast: (msg: { type: string; payload: unknown }) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  currentSessionId: () => string;
  queueTextDelta: StreamCoalescer['queueTextDelta'];
  queueThinkingDelta: StreamCoalescer['queueThinkingDelta'];
  queueToolProgress: StreamCoalescer['queueToolProgress'];
  flushThinkingDelta: StreamCoalescer['flushThinkingDelta'];
  flushAllStreamBuffers: StreamCoalescer['flushAllStreamBuffers'];
  pendingConfirms: Map<string, PendingConfirm>;
  secretScrubber: SecretScrubber;
  /** Live clients getter for the shared eternal-iteration subscription. */
  getClients: Parameters<typeof createEternalSubscription>[2];
  /** Shared disposer list — the caller also pushes non-event disposers here. */
  eventUnsubscribers: Array<() => void>;
}

export function createSetupEvents(deps: SetupEventsDeps): () => void {
  const {
    broadcast,
    sessionPayload,
    currentSessionId,
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
    pendingConfirms,
    secretScrubber,
    getClients,
    eventUnsubscribers,
  } = deps;

  // ── Fleet concurrency tracking ────────────────────────────────────────────
  // Tracks how many subagents are currently active (running) so the WebUI's
  // ConcurrencyGauge can show [████░░] 2/4 instead of always 0/4.
  // The leader is NOT counted — it's the host process, not a spawned worker.
  let fleetConcurrency = 0;
  // Default max matches the CLI default fleet size (4). A future
  // fleet.max_concurrency kernel event could override this dynamically.
  let fleetConcurrencyMax = 4;
  const emitConcurrency = () =>
    broadcast({
      type: 'fleet.concurrency_update',
      payload: sessionPayload({ fleetConcurrency, fleetConcurrencyMax }),
    });


  return function setupEvents(): void {
      // Clear any existing subscriptions
      for (const unsub of eventUnsubscribers) unsub();
      eventUnsubscribers.length = 0;

      // ── Leader identity — the host is always the leader (agentId 'leader').
      // Emit once so the WebUI's fleet store sets leaderId and shows the crown.
      broadcast({
        type: 'subagent.event',
        payload: sessionPayload({
          kind: 'leader_updated',
          subagentId: 'leader',
          isLeader: true,
          name: 'Leader',
          status: 'running',
        }),
      });

      // ── Fleet concurrency — emit the initial 0/N state so the gauge
      // renders immediately instead of waiting for the first spawn event.
      emitConcurrency();

      // iteration.started
      eventUnsubscribers.push(
        deps.events.on('iteration.started', (e) => {
          // Include maxIterations (from the seeded meta) so the UI's
          // "iteration N / max" affordance works the same as under the
          // standalone server, which already sends it.
          const maxIt = deps.agent.ctx.meta['maxIterations'];
          broadcast({
            type: 'iteration.started',
            payload: sessionPayload({
              sessionId: e.sessionId,
              index: e.index,
              ...(typeof maxIt === 'number' ? { maxIterations: maxIt } : {}),
            }),
          });
        }),
      );

      eventUnsubscribers.push(
        deps.events.on('iteration.completed', (e) => {
          broadcast({
            type: 'iteration.completed',
            payload: sessionPayload({ sessionId: e.sessionId, index: e.index, totalIterations: e.index + 1 }),
          });
        }),
        deps.events.on('iteration.limit_reached', (e) => {
          broadcast({
            type: 'iteration.limit_reached',
            payload: sessionPayload({
              sessionId: e.sessionId,
              currentIterations: e.currentIterations,
              currentLimit: e.currentLimit,
            }),
          });
        }),
      );

      // provider.text_delta
      eventUnsubscribers.push(
        deps.events.on('provider.text_delta', (e) => {
          flushThinkingDelta();
          queueTextDelta(e.text, e.sessionId);
        }),
      );

      // provider.thinking_delta — extended-thinking deltas. The WebUI renders a
      // transient "Thinking…" chip from these and archives the full burst as a
      // collapsible thinking log when the iteration ends.
      eventUnsubscribers.push(
        deps.events.on('provider.thinking_delta', (e) => {
          queueThinkingDelta(e.text, e.sessionId);
        }),
      );

      eventUnsubscribers.push(
        deps.events.on('provider.stream_error', (e) => {
          broadcast({
            type: 'provider.stream_error',
            payload: sessionPayload({ sessionId: e.sessionId, eventType: e.eventType, message: e.msg }),
          });
        }),
      );

      // tool.started
      eventUnsubscribers.push(
        deps.events.on('tool.started', (e) => {
          flushAllStreamBuffers();
          broadcast({
            type: 'tool.started',
            payload: sessionPayload({
              sessionId: e.sessionId,
              id: e.id,
              name: e.name,
              input: secretScrubber.scrubObject(e.input),
              messageId: `tool_${e.id}`,
            }),
          });
        }),
      );

      // tool.progress
      eventUnsubscribers.push(
        deps.events.on('tool.progress', (e) => {
          queueToolProgress({
            sessionId: e.sessionId,
            name: e.name,
            id: e.id,
            event: e.event,
          });
        }),
      );

      // tool.executed
      eventUnsubscribers.push(
        deps.events.on('tool.executed', (e) => {
          flushAllStreamBuffers();
          broadcast({
            type: 'tool.executed',
            payload: sessionPayload({
              sessionId: e.sessionId,
              // Forward the tool_use id so the WebUI can correlate this with
              // the matching tool.started bubble for parallel tool calls.
              id: e.id,
              name: e.name,
              durationMs: e.durationMs,
              ok: e.ok,
              input: secretScrubber.scrubObject(e.input),
              output: secretScrubber.scrubObject(e.output),
            }),
          });

          // Always broadcast current todos so the panel stays in sync.
          broadcast({
            type: 'todos.updated',
            payload: sessionPayload({ sessionId: e.sessionId, todos: [...deps.agent.ctx.todos] }),
          });

          // After task/plan/todo tool executions, also broadcast those snapshots.
          if (e.name === 'task' || e.name === 'plan' || e.name === 'todo') {
            void (async () => {
              try {
                const taskPath = (deps.agent.ctx.meta as Record<string, unknown>)['task.path'];
                if (typeof taskPath === 'string' && taskPath) {
                  const { loadTasks } = await import('@wrongstack/core');
                  const file = await loadTasks(taskPath);
                  broadcast({
                    type: 'tasks.updated',
                    payload: sessionPayload({ sessionId: e.sessionId, tasks: file?.tasks ?? [] }),
                  });
                }
              } catch {
                /* best-effort */
              }
              try {
                const planPath = (deps.agent.ctx.meta as Record<string, unknown>)['plan.path'];
                if (typeof planPath === 'string' && planPath) {
                  const { loadPlan } = await import('@wrongstack/core');
                  const plan = await loadPlan(planPath);
                  broadcast({
                    type: 'plan.updated',
                    payload: sessionPayload({
                      sessionId: e.sessionId,
                      plan: plan ?? {
                        version: 1,
                        sessionId: e.sessionId ?? currentSessionId(),
                        updatedAt: new Date().toISOString(),
                        items: [],
                      },
                    }),
                  });
                }
              } catch {
                /* best-effort */
              }
            })();
          }
        }),
      );

      eventUnsubscribers.push(
        deps.events.on('tool.loop_detected', (e) => {
          broadcast({
            type: 'tool.loop_detected',
            payload: sessionPayload({
              sessionId: e.sessionId,
              tools: e.tools,
              repeatCount: e.repeatCount,
              iteration: e.iteration,
              kind: e.kind,
            }),
          });
        }),
        deps.events.on('trust.persisted', (e) => {
          broadcast({
            type: 'trust.persisted',
            payload: sessionPayload({ sessionId: e.sessionId, tool: e.tool, pattern: e.pattern, decision: e.decision }),
          });
        }),
        deps.events.on('delegate.started', (e) => {
          broadcast({
            type: 'delegate.started',
            payload: sessionPayload({ sessionId: e.sessionId, target: e.target, task: e.task }),
          });
        }),
        deps.events.on('delegate.completed', (e) => {
          broadcast({
            type: 'delegate.completed',
            payload: sessionPayload({
              sessionId: e.sessionId,
              target: e.target,
              task: e.task,
              ok: e.ok,
              status: e.status,
              summary: e.summary,
              durationMs: e.durationMs,
              iterations: e.iterations,
              toolCalls: e.toolCalls,
              costUsd: e.costUsd,
              subagentId: e.subagentId,
            }),
          });
        }),
      );

      // provider.response
      eventUnsubscribers.push(
        deps.events.on('provider.response', (e) => {
          flushAllStreamBuffers();
          broadcast({
            type: 'provider.response',
            payload: sessionPayload({
              sessionId: e.sessionId,
              usage: e.usage,
              stopReason: e.stopReason,
              messageId: 'current',
            }),
          });
        }),
      );

      eventUnsubscribers.push(
        deps.events.on('ctx.pct', (e) => {
          broadcast({
            type: 'ctx.pct',
            payload: sessionPayload({ sessionId: e.sessionId, load: e.load, tokens: e.tokens, maxContext: e.maxContext }),
          });
          broadcast({
            type: 'subagent.event',
            payload: sessionPayload({
              sessionId: e.sessionId,
              kind: 'ctx_pct',
              subagentId: 'leader',
              load: e.load,
              tokens: e.tokens,
              maxContext: e.maxContext,
            }),
          });
        }),
        deps.events.on('ctx.max_context', (e) => {
          broadcast({
            type: 'ctx.max_context',
            payload: sessionPayload({ sessionId: e.sessionId, providerId: e.providerId, modelId: e.modelId, maxContext: e.maxContext }),
          });
        }),
        deps.events.on('context.repaired', (e) => {
          broadcast({
            type: 'context.repaired',
            payload: sessionPayload({
              sessionId: e.sessionId,
              removedToolUses: e.removedToolUses,
              removedToolResults: e.removedToolResults,
              removedMessages: e.removedMessages,
            }),
          });
        }),
        deps.events.on('token.threshold', (e) => {
          broadcast({
            type: 'token.threshold',
            payload: sessionPayload({ sessionId: e.sessionId, used: e.used, limit: e.limit }),
          });
        }),
        deps.events.on('token.cost_estimate_unavailable', (e) => {
          broadcast({
            type: 'token.cost_estimate_unavailable',
            payload: sessionPayload({ sessionId: e.sessionId, model: e.model }),
          });
        }),
      );

      eventUnsubscribers.push(
        deps.events.on('provider.retry', (e) => {
          broadcast({
            type: 'provider.retry',
            payload: sessionPayload({
              sessionId: e.sessionId,
              providerId: e.providerId,
              attempt: e.attempt,
              delayMs: e.delayMs,
              status: e.status,
              description: e.description,
            }),
          });
        }),
        deps.events.on('provider.error', (e) => {
          broadcast({
            type: 'provider.error',
            payload: sessionPayload({
              sessionId: e.sessionId,
              providerId: e.providerId,
              status: e.status,
              description: e.description,
              retryable: e.retryable,
            }),
          });
        }),
        deps.events.on('provider.fallback', (e) => {
          broadcast({
            type: 'provider.fallback',
            payload: sessionPayload({
              sessionId: e.sessionId,
              from: e.from,
              to: e.to,
              status: e.status,
              providerSwitched: e.providerSwitched,
            }),
          });
        }),
        deps.events.on('compaction.fired', (e) => {
          broadcast({
            type: 'context.compacted',
            payload: sessionPayload({
              sessionId: e.sessionId,
              before: e.report.before,
              after: e.report.after,
              saved: Math.max(0, e.report.before - e.report.after),
              reductions: e.report.reductions,
            }),
          });
        }),
        deps.events.on('compaction.failed', (e) => {
          broadcast({
            type: 'compaction.failed',
            payload: sessionPayload({
              sessionId: e.sessionId,
              message: e.err.message,
              aggressive: e.aggressive,
              level: e.level,
              tokens: e.tokens,
              maxContext: e.maxContext,
              load: e.load,
              fatal: e.fatal,
            }),
          });
        }),
        deps.events.on('mcp.server.connected', (e) => {
          broadcast({
            type: 'mcp.server.connected',
            payload: { name: e.name, toolCount: e.toolCount },
          });
        }),
        deps.events.on('mcp.server.reconnected', (e) => {
          broadcast({
            type: 'mcp.server.reconnected',
            payload: { name: e.name, toolCount: e.toolCount },
          });
        }),
        deps.events.on('mcp.server.disconnected', (e) => {
          broadcast({
            type: 'mcp.server.disconnected',
            payload: { name: e.name, reason: e.reason },
          });
        }),
        deps.events.on('coordinator.stats', (e) => {
          broadcast({
            type: 'coordinator.stats',
            payload: sessionPayload({
              sessionId: e.sessionId,
              total: e.total,
              running: e.running,
              idle: e.idle,
              stopped: e.stopped,
              inFlight: e.inFlight,
              pending: e.pending,
              completed: e.completed,
              subagentStatuses: e.subagentStatuses.map((s) => ({
                id: s.subagentId,
                name: s.subagentId,
                status: s.status,
                currentTask: s.taskId,
              })),
            }),
          });
        }),
      );

      // error
      eventUnsubscribers.push(
        deps.events.on('error', (e) => {
          broadcast({
            type: 'error',
            payload: sessionPayload({
              sessionId: e.sessionId,
              phase: e.phase,
              message: e.err instanceof Error ? e.err.message : String(e.err),
            }),
          });
        }),
      );

      eventUnsubscribers.push(
        deps.events.on('session.damaged', (e) => {
          broadcast({
            type: 'session.damaged',
            payload: { sessionId: e.sessionId, detail: e.detail },
          });
        }),
        deps.events.on('session.rewound', (e) => {
          broadcast({
            type: 'session.rewound',
            payload: sessionPayload({
              sessionId: e.sessionId,
              toPromptIndex: e.toPromptIndex,
              revertedFiles: e.revertedFiles,
              removedEvents: e.removedEvents,
            }),
          });
        }),
        deps.events.on('checkpoint.written', (e) => {
          broadcast({
            type: 'checkpoint.written',
            payload: sessionPayload({
              sessionId: e.sessionId,
              promptIndex: e.promptIndex,
              promptPreview: e.promptPreview,
              ts: e.ts,
              fileCount: e.fileCount,
            }),
          });
        }),
        deps.events.on('in_flight.started', (e) => {
          broadcast({
            type: 'in_flight.started',
            payload: sessionPayload({ sessionId: e.sessionId, context: e.context, ts: e.ts }),
          });
        }),
        deps.events.on('in_flight.ended', (e) => {
          broadcast({
            type: 'in_flight.ended',
            payload: sessionPayload({ sessionId: e.sessionId, reason: e.reason, ts: e.ts }),
          });
        }),
        deps.events.on('concurrency.changed', (e) => {
          fleetConcurrencyMax = Math.max(1, e.n);
          emitConcurrency();
        }),
      );

      // tool.confirm_needed — forward permission prompts to the browser so the
      // user approves/denies in the WebUI rather than the terminal. Requires the
      // agent to be in event-driven confirmation mode (the --webui launch path
      // calls disableInteractiveConfirmation()).
      eventUnsubscribers.push(
        deps.events.on('tool.confirm_needed', (e) => {
          const id = e.toolUseId ?? `confirm_${Date.now()}`;
          pendingConfirms.set(id, {
            resolve: e.resolve,
            decisionSource: e.decisionSource,
            riskTier: e.riskTier,
          });
          broadcast({
            type: 'tool.confirm_needed',
            payload: sessionPayload({
              sessionId: e.sessionId,
              id,
              toolName: e.tool?.name ?? 'unknown',
              input: secretScrubber.scrubObject(e.input),
              suggestedPattern: e.suggestedPattern,
              decisionSource: e.decisionSource,
              riskTier: e.riskTier,
            }),
          });
        }),
      );

      // Subagent fleet lifecycle. The kernel emits a rich subagent.* catalog on
      // the host bus (spawn → task → per-tool → periodic summary → completion).
      // We flatten the relevant ones into a single `subagent.event` stream with a
      // `kind` discriminator so the WebUI can render a live fleet roster (the
      // nickname'd leader/worker agents) without subscribing to the director-only
      // FleetBus. No tool inputs/outputs are forwarded here — only names + counts
      // — so there's nothing to scrub.
      const forwardSubagent = (kind: string, payload: Record<string, unknown>) =>
        broadcast({ type: 'subagent.event', payload: sessionPayload({ kind, ...payload }) });
      eventUnsubscribers.push(
        deps.events.on('subagent.spawned', (e) => {
          fleetConcurrency += 1;
          emitConcurrency();
          forwardSubagent('spawned', {
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            taskId: e.taskId,
            name: e.name,
            provider: e.provider,
            model: e.model,
            description: e.description,
          });
        }),
        deps.events.on('subagent.task_started', (e) =>
          forwardSubagent('task_started', {
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            taskId: e.taskId,
            description: e.description,
          }),
        ),
        deps.events.on('subagent.tool_executed', (e) =>
          forwardSubagent('tool_executed', {
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            toolName: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
          }),
        ),
        deps.events.on('subagent.iteration_summary', (e) =>
          forwardSubagent('iteration_summary', {
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            iteration: e.iteration,
            toolCalls: e.toolCalls,
            costUsd: e.costUsd,
            currentTool: e.currentTool,
            partialText: e.partialText,
          }),
        ),
        deps.events.on('subagent.budget_warning', (e) =>
          forwardSubagent('budget_warning', {
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            budgetKind: e.kind,
            used: e.used,
            limit: e.limit,
          }),
        ),
        deps.events.on('subagent.budget_extended', (e) =>
          forwardSubagent('budget_extended', {
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            budgetKind: e.kind,
            newLimit: e.newLimit,
            totalExtensions: e.totalExtensions,
          }),
        ),
        deps.events.on('subagent.ctx_pct', (e) =>
          forwardSubagent('ctx_pct', {
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            load: e.load,
            tokens: e.tokens,
            maxContext: e.maxContext,
          }),
        ),
        deps.events.on('subagent.task_completed', (e) => {
          fleetConcurrency = Math.max(0, fleetConcurrency - 1);
          emitConcurrency();
          forwardSubagent('task_completed', {
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            status: e.status,
            iterations: e.iterations,
            toolCalls: e.toolCalls,
            finalText: (e as Record<string, unknown>).finalText as string | undefined,
            failureReason: e.error?.kind,
            error: e.error ? { kind: e.error.kind, message: e.error.message } : undefined,
          });
        }),
      );

      // ── Agent timeline events — WebUI conversation stream ─────────────
      deps.events.on('agent.timeline.message', (e) => {
        broadcast({
          type: 'agent.timeline.message',
          payload: sessionPayload({
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            agentName: e.agentName,
            content: e.content,
            kind: e.kind,
            iteration: e.iteration,
            ts: e.ts,
            toolName: e.toolName,
            costUsd: e.costUsd,
          }),
        });
      });
      deps.events.on('agent.status_changed', (e) => {
        broadcast({
          type: 'agent.status_changed',
          payload: sessionPayload({
            sessionId: e.sessionId,
            subagentId: e.subagentId,
            agentName: e.agentName,
            status: e.status,
            ts: e.ts,
            summary: e.summary,
            task: e.task,
          }),
        });
      });

      // eternal-autonomy iteration events. Each iteration the engine
      // completes lands here and is fanned out to every connected client
      // so the frontend can render a live timeline of the autonomous loop.
      // Wired through `createEternalSubscription` (shared with `@wrongstack/webui/server`'s
      // standalone `startWebUI`) so the `eternal.iteration` payload shape stays
      // in lockstep across the two entry points — earlier revisions spelled out
      // every field by hand here, which drifted from the standalone shape
      // (`{ entry: JournalEntry }`) and forced the frontend to keep two
      // deserializers. The whole `JournalEntry` (including the CLI-only
      // `costUsd` delta) now rides in the `entry` field.
      if (deps.subscribeEternalIteration) {
        const subscription = createEternalSubscription(
          deps.subscribeEternalIteration,
          (_liveClients, msg) => broadcast(msg),
          getClients,
        );
        eventUnsubscribers.push(() => subscription.dispose());
      }

      // ── Mailbox events — broadcast to WebUI for real-time per-project visibility ──
      // Enables the WebUI to update its online agent count and mailbox panel without polling.
      eventUnsubscribers.push(
        deps.events.onPattern('mailbox.*', (eventName, payload) => {
          broadcast({
            type: 'mailbox.event',
            payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
          });
        }),
      );

      // ── Brain events — decisions + proactive interventions, live in the browser ──
      eventUnsubscribers.push(
        deps.events.onPattern('brain.*', (eventName, payload) => {
          broadcast({
            type: 'brain.event',
            payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
          });
        }),
      );
  };
}
