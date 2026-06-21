/**
 * TUI session resume — extracted from the runTui() options literal.
 *
 * Phase C step 2. The onResumeSession callback swaps the agent's session
 * writer, resets token accounting, re-points the crash-recovery lock,
 * and replays the JSONL events as TUI history entries.
 *
 * Reads mutable state from TuiRuntimeState (activeSessionStore,
 * activeRecoveryLock, wpaths).
 */
import * as path from 'node:path';
import type { Agent, TokenCounter } from '@wrongstack/core';
import type { TuiRuntimeState } from './tui-runtime-state.js';

export interface SessionResumeContext {
  state: TuiRuntimeState;
  agent: Agent;
  tokenCounter: TokenCounter;
  switchProviderAndModel: ((providerId: string, modelId: string) => void) | undefined;
}

export interface SessionResumeResult {
  entries: unknown[];
  nextId: number;
  sessionId: string;
}

/**
 * Resume a past session by id.
 *
 * Returns the replayed history entries + new session id, or null on
 * failure. Throws if the session is live in another process.
 */
export async function resumeSession(
  ctx: SessionResumeContext,
  sessionId: string,
): Promise<SessionResumeResult | null> {
  const { state, agent, tokenCounter, switchProviderAndModel } = ctx;

  if (!state.activeSessionStore) return null;

  // Refuse to resume a session that a LIVE process owns — two
  // writers on one session JSONL corrupt it. Thrown (not null) so
  // the resume picker surfaces the reason instead of a generic
  // failure. Best-effort: a broken registry must not block resume.
  try {
    const { SessionRegistry } = await import('@wrongstack/core');
    const registry = new SessionRegistry(path.dirname(state.wpaths.globalConfig));
    const live = (await registry.list()).find(
      (s) => s.sessionId === sessionId && s.status !== 'stale' && s.pid !== process.pid,
    );
    if (live) {
      throw new Error(
        `Session is open in another running wstack (pid ${live.pid}) — it cannot be resumed here while live.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Session is open')) throw err;
    // registry unreadable — fall through to the normal resume path
  }

  try {
    const resumed = await state.activeSessionStore.resume(sessionId);
    const meta = resumed.data.metadata;

    // Rebuild the agent's conversation context from the resumed
    // messages. Go through the observable state wrapper (NOT direct
    // array mutation) so onChange subscribers fire and tool-use
    // adjacency is re-checked on the next request.
    agent.ctx.state.replaceMessages(resumed.data.messages);

    // Sync the agent's model/provider to what was used in the
    // resumed session. If the resumed session used a different
    // provider or model, switch to it so the agent uses the
    // correct API endpoint and context window.
    if (meta.model && meta.model !== agent.ctx.model) {
      agent.ctx.model = meta.model;
    }
    if (meta.provider) {
      const currentProviderId = (agent.ctx.provider as { id?: string }).id;
      if (meta.provider !== currentProviderId && switchProviderAndModel) {
        switchProviderAndModel(meta.provider as string, meta.model ?? agent.ctx.model);
      }
    }

    // Finalize the current session: append a session_end (so the
    // log ends cleanly and recovery/summaries see a completed
    // session), then close (flush + summary sidecar + index). Use
    // agent.ctx.session (the currently active writer) rather than
    // the captured `session` variable — the user may have resumed
    // before, in which case `session` is stale.
    // Fire-and-forget: don't block resume on the close.
    const oldWriter = agent.ctx.session;
    if (oldWriter && oldWriter !== resumed.writer) {
      // Capture the OLD session's usage synchronously — the counter
      // is reset for the resumed session below, and this closure
      // runs after that reset.
      const endedUsage = tokenCounter.total();
      void (async () => {
        let appendOk = false;
        try {
          await oldWriter.append({
            type: 'session_end',
            ts: new Date().toISOString(),
            usage: endedUsage,
          });
          appendOk = true;
        } catch (err) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'execution.session_end_append_failed',
              message: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }),
          );
        }
        // Only close if session_end was successfully appended — closing
        // a partially-written session file corrupts recovery/summaries.
        if (appendOk) {
          try {
            await oldWriter.close();
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'execution.session_close_failed',
                message: err instanceof Error ? err.message : String(err),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
      })();
    }

    // Swap the session writer: new events (tool calls, LLM responses)
    // will append to the resumed session's JSONL, not the old one.
    agent.ctx.session = resumed.writer;

    // Token accounting is per-session: without a reset the resumed
    // session's summary/cost chips inherit the old session's totals.
    tokenCounter.reset();

    // Re-point crash recovery (active.json) at the resumed session —
    // otherwise a crash after this resume would offer recovery for
    // the OLD (cleanly finalized) session and miss the live one.
    // Fire-and-forget: do not block resume on recovery lock errors.
    void (async () => {
      try {
        await state.activeRecoveryLock.clear();
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'execution.recovery_lock_clear_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
      try {
        await state.activeRecoveryLock.write(resumed.writer.id);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'execution.recovery_lock_update_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    })();

    // Replay the JSONL events as TUI history entries.
    const { replaySessionEvents } = await import('@wrongstack/tui');
    const entries = replaySessionEvents(resumed.data.events, /* startId */ 1);

    return {
      entries,
      nextId: entries.length + 1,
      sessionId: resumed.writer.id,
    };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'execution.resume_session_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
}
