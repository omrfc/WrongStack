/**
 * mailbox-hooks — Tool-execution hooks for mailbox integration.
 *
 * 1. Before each tool call, checks the mailbox for unread high-priority
 *    steer messages and emits a `mailbox.unread_count` event.
 * 2. After each tool call, updates the agent heartbeat so other agents
 *    know this one is still alive.
 *
 * This gives near-real-time mailbox checking (every tool call, not just
 * iteration boundaries) and powers the "new mail" badge in the WebUI/TUI.
 *
 * @module mailbox-hooks
 */

import type { Mailbox } from '../coordination/mailbox-types.js';

export interface MailboxHooksOptions {
  /** The mailbox instance. */
  mailbox: Mailbox;
  /** Agent id for read-receipt and unread-check purposes. */
  agentId: string;
  /** Whether to emit new-mail notifications. Default: true. */
  notifyNewMail?: boolean | undefined;
  /** Whether to update heartbeat. Default: true. */
  heartbeat?: boolean | undefined;
}

/**
 * Create a pair of hooks for the tool execution pipeline.
 *
 * Usage:
 *   const hooks = createMailboxHooks({ mailbox, agentId });
 *   // In the tool executor, before each tool call:
 *   await hooks.beforeTool({ events });
 *   // After each tool call:
 *   await hooks.afterTool();
 *
 * The `beforeTool` hook checks for unread messages and emits
 * `mailbox.unread_count` events. The `afterTool` hook updates
 * the agent heartbeat.
 */
export function createMailboxHooks(opts: MailboxHooksOptions) {
  const { mailbox, agentId, notifyNewMail = true, heartbeat = true } = opts;

  let lastUnreadCount = -1;

  return {
    /**
     * Call before each tool execution. Checks mailbox and emits events.
     * @param events — EventBus-like object with emit method.
     */
    async beforeTool(events: { emit: (type: string, payload: unknown) => void }): Promise<void> {
      try {
        const count = await mailbox.unreadCount(agentId);

        // Emit unread count if it changed (avoids spamming identical events)
        if (notifyNewMail && count !== lastUnreadCount) {
          lastUnreadCount = count;
          events.emit('mailbox.unread_count', { agentId, count });
        }
      } catch {
        // Mailbox unavailable — silent
      }
    },

    /**
     * Call after each tool execution. Updates heartbeat and optionally
     * current tool status.
     */
    async afterTool(toolName?: string): Promise<void> {
      if (!heartbeat) return;
      try {
        await mailbox.heartbeat({
          agentId,
          status: 'running',
          currentTool: toolName,
        });
      } catch {
        // Best-effort
      }
    },

    /** Reset the cached unread count (e.g., after the agent checks manually). */
    reset() {
      lastUnreadCount = -1;
    },
  };
}
