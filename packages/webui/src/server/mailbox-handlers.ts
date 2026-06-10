/**
 * Mailbox WebSocket handlers for the WebUI.
 *
 * Handles `mailbox.messages` and `mailbox.agents` message types.
 * The frontend sends these to populate the mailbox panel; the server
 * reads from the project-level GlobalMailbox and responds.
 */

import * as path from 'node:path';
import type { WebSocket } from 'ws';
import { GlobalMailbox } from '@wrongstack/core';
import { send, errMessage } from './ws-utils.js';

// ── Helpers ───────────────────────────────────────────────────────────

function resolveProjectDir(projectRoot: string, globalRoot: string): string {
  const { createHash } = require('node:crypto');
  const hash = createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 6);
  const slug = path
    .basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40) || 'project';
  return path.join(globalRoot, 'projects', `${slug}-${hash}`);
}

export interface MailboxHandlerDeps {
  /** Absolute project root. */
  projectRoot: string;
  /** Global WrongStack root (~/.wrongstack). */
  globalRoot: string;
}

// ── Handlers ──────────────────────────────────────────────────────────

/**
 * List recent mailbox messages. Frontend sends:
 *   { type: 'mailbox.messages', limit?: number, agentId?: string }
 */
export async function handleMailboxMessages(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  payload: { limit?: number; agentId?: string; unreadOnly?: boolean } | undefined,
): Promise<void> {
  try {
    const dir = resolveProjectDir(deps.projectRoot, deps.globalRoot);
    const mb = new GlobalMailbox(dir);
    const messages = await mb.query({
      limit: payload?.limit ?? 30,
      to: payload?.agentId,
      unreadBy: payload?.unreadOnly ? payload.agentId : undefined,
    });
    send(ws, {
      type: 'mailbox.messages',
      payload: {
        messages: messages.map((m) => ({
          id: m.id, from: m.from, to: m.to, type: m.type,
          subject: m.subject, body: m.body, priority: m.priority,
          readBy: m.readBy, readByCount: Object.keys(m.readBy).length,
          completed: m.completed, completedBy: m.completedBy,
          outcome: m.outcome, timestamp: m.timestamp,
          replyTo: m.replyTo, senderSessionId: m.senderSessionId,
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
