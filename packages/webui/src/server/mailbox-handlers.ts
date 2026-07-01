/**
 * Mailbox WebSocket handlers for the WebUI.
 *
 * Handles `mailbox.messages` and `mailbox.agents` message types.
 * The frontend sends these to populate the mailbox panel; the server
 * reads from the project-level GlobalMailbox and responds.
 */

import type { WebSocket } from 'ws';
import { GlobalMailbox, resolveProjectDir } from '@wrongstack/core';
import { send, errMessage } from './ws-utils.js';

export interface MailboxHandlerDeps {
  /** Absolute project root. */
  projectRoot: string;
  /** Global WrongStack root (~/.wrongstack). */
  globalRoot: string;
}

// ── Handlers ──────────────────────────────────────────────────────────

/**
 * List recent mailbox messages. Frontend sends:
 *   { type: 'mailbox.messages', limit?: number, incompleteOnly?: boolean }
 *
 * Uses `incompleteOnly` so the server filters to active/unread messages,
 * making readByCount === 0 a reliable "unread to all agents" signal for
 * the ActivityBar badge count.
 */
export async function handleMailboxMessages(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  payload: { limit?: number; agentId?: string; unreadOnly?: boolean; incompleteOnly?: boolean } | undefined,
): Promise<void> {
  try {
    const dir = resolveProjectDir(deps.projectRoot, deps.globalRoot);
    const mb = new GlobalMailbox(dir);
    const limit = payload?.limit ?? 30;
    const unreadForAgent = payload?.unreadOnly === true && payload.agentId !== undefined;
    const messages = await mb.query({
      limit: payload?.unreadOnly === true && payload.agentId === undefined ? Math.max(limit * 5, 100) : limit,
      to: payload?.agentId,
      unreadBy: unreadForAgent ? payload.agentId : undefined,
      incompleteOnly: payload?.incompleteOnly ?? false,
    });
    const visibleMessages = payload?.unreadOnly === true && payload.agentId === undefined
      ? messages.filter((m) => Object.keys(m.readBy).length === 0).slice(0, limit)
      : messages;
    send(ws, {
      type: 'mailbox.messages',
      payload: {
        messages: visibleMessages.map((m) => ({
          id: m.id, from: m.from, to: m.to, type: m.type,
          subject: m.subject, body: m.body, priority: m.priority,
          readBy: m.readBy, readByCount: Object.keys(m.readBy).length,
          completed: m.completed, completedBy: m.completedBy,
          completedAt: m.completedAt, outcome: m.outcome, timestamp: m.timestamp,
          replyTo: m.replyTo, senderSessionId: m.senderSessionId,
          taskContext: m.taskContext,
        })),
      },
    });
  } catch (err) {
    send(ws, { type: 'mailbox.messages', payload: { messages: [], error: errMessage(err) } });
  }
}

/**
 * List registered agents. Frontend sends:
 *   { type: 'mailbox.agents', onlineOnly?: boolean }
 */
export async function handleMailboxAgents(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  payload: { onlineOnly?: boolean } | undefined,
): Promise<void> {
  try {
    const dir = resolveProjectDir(deps.projectRoot, deps.globalRoot);
    const mb = new GlobalMailbox(dir);
    const agents = payload?.onlineOnly
      ? await mb.getOnlineAgents()
      : await mb.getAgentStatuses();
    send(ws, {
      type: 'mailbox.agents',
      payload: {
        agents: agents.map((a) => ({
          agentId: a.agentId, name: a.name, role: a.role,
          sessionId: a.sessionId, status: a.status,
          currentTool: a.currentTool, currentTask: a.currentTask,
          iterations: a.iterations, toolCalls: a.toolCalls,
          lastSeenAt: a.lastSeenAt, online: a.online,
          pid: a.pid, source: a.source,
        })),
      },
    });
  } catch (err) {
    send(ws, { type: 'mailbox.agents', payload: { agents: [], error: errMessage(err) } });
  }
}

/**
 * Delete all messages from the mailbox. Frontend sends:
 *   { type: 'mailbox.clear' }
 * Server responds with 'mailbox.cleared'.
 */
export async function handleMailboxClear(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
): Promise<void> {
  try {
    const dir = resolveProjectDir(deps.projectRoot, deps.globalRoot);
    const mb = new GlobalMailbox(dir);
    await mb.clearAll();
    send(ws, { type: 'mailbox.cleared', payload: {} });
  } catch (err) {
    send(ws, { type: 'mailbox.cleared', payload: { error: errMessage(err) } });
  }
}

/**
 * Purge stale/orphaned messages from the mailbox. Frontend sends:
 *   { type: 'mailbox.purge', payload?: { completedMaxAgeMs?: number; incompleteMaxAgeMs?: number } }
 * Server responds with 'mailbox.purged'.
 */
export async function handleMailboxPurge(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  opts?: { completedMaxAgeMs?: number; incompleteMaxAgeMs?: number },
): Promise<void> {
  try {
    const dir = resolveProjectDir(deps.projectRoot, deps.globalRoot);
    const mb = new GlobalMailbox(dir);
    const result = await mb.purgeStale(opts);
    send(ws, { type: 'mailbox.purged', payload: result });
  } catch (err) {
    send(ws, { type: 'mailbox.purged', payload: { error: errMessage(err) } });
  }
}
