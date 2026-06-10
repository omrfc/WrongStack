/**
 * mailbox-tool — Tool that exposes the inter-agent mailbox to agents.
 *
 * Sub-commands: check, send, ack, query, status, online, unread
 *
 * Uses the project-level GlobalMailbox for cross-session communication.
 * Agents are auto-registered on first use with heartbeat tracking.
 * Read receipts track who read each message and when.
 *
 * @module mailbox-tool
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import type { Context } from '../core/context.js';
import type { Tool } from '../types/tool.js';
import { GlobalMailbox, resolveProjectDir } from './global-mailbox.js';
import type { Mailbox, MailboxMessage, MailboxMessageType } from './mailbox-types.js';

export type MailboxResolver = (ctx: Context) => Mailbox;

export interface MailboxToolOptions {
  /**
   * How to obtain a Mailbox instance given the execution Context.
   * Default: derives project dir from ctx and creates a GlobalMailbox.
   */
  resolveMailbox?: MailboxResolver | undefined;
  /**
   * Agent id of the caller — used as default "from" on send.
   * Default: 'leader' for the main agent, or derived from ctx.meta.
   */
  agentId?: string | undefined;
  /** Session id for cross-session communication. Default: derived from ctx. */
  sessionId?: string | undefined;
  /**
   * Project directory where the mailbox is stored.
   * Default: derived from ctx.projectRoot (may differ from wpaths.projectDir).
   * For correct cross-session sharing, pass `wpaths.projectDir` from the caller.
   */
  projectDir?: string | undefined;
  /**
   * EventBus for emitting mailbox.agent_registered and mailbox.agent_heartbeat
   * events so the TUI/WebUI can update the online agent count in the status bar.
   * When omitted, events are not emitted and the status bar count stays at 0.
   */
  events?: EventBus | undefined;
}

function defaultResolveProjectDir(ctx: Context): string {
  const home = os.homedir();
  return resolveProjectDir(ctx.projectRoot, path.join(home, '.wrongstack'));
}

export function makeMailboxTool(opts: MailboxToolOptions = {}): Tool {
  const resolveMailbox = opts.resolveMailbox ?? ((ctx: Context) => {
    const dir = opts.projectDir ?? defaultResolveProjectDir(ctx);
    return new GlobalMailbox(dir, opts.events);
  });
  const agentId = opts.agentId ?? 'leader';
  const sessionId = opts.sessionId ?? 'default';

  const shortHint =
    'Sub-commands: check (unread), send (to/broadcast), ack (read/complete), query (filter), status (all agents), online (active only), unread (count).';

  return {
    name: 'mailbox',
    description:
      'Inter-agent mailbox with cross-session support. Send messages, check for incoming messages, acknowledge with read receipts, query by criteria, see online agents.',
    usageHint: shortHint,
    category: 'coordination',
    permission: 'auto',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'send', 'ack', 'query', 'status', 'online', 'unread'],
          description: 'Which mailbox operation to perform.',
        },
        to: { type: 'string', description: "Recipient agent id, or '*' for broadcast." },
        type: { type: 'string', enum: ['note', 'ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result'], description: 'Message type.' },
        subject: { type: 'string', description: 'Short subject line.' },
        body: { type: 'string', description: 'Full message content.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        replyTo: { type: 'string', description: 'Reply to a specific message id.' },
        messageId: { type: 'string', description: "Message id to acknowledge. Required for 'ack'." },
        read: { type: 'boolean', description: 'Mark as read (adds read receipt).' },
        completed: { type: 'boolean', description: 'Mark as completed.' },
        outcome: { type: 'string', description: 'Outcome summary when marking complete.' },
        unreadBy: { type: 'string', description: "Filter messages unread by this agent. Used by 'check'." },
        incompleteOnly: { type: 'boolean', description: 'Only incomplete messages.' },
        from: { type: 'string', description: "Filter by sender." },
        minPriority: { type: 'string', enum: ['low', 'normal', 'high'] },
        since: { type: 'string', description: 'ISO8601 timestamp — only messages after this.' },
        limit: { type: 'number', description: 'Max messages to return.' },
      },
      required: ['action'],
    },
    async execute(input: unknown, ctx: Context) {
      const mb = resolveMailbox(ctx);
      const i = (input ?? {}) as Record<string, unknown>;
      const action = i.action as string | undefined;
      const callerId = (ctx.meta['agentId'] as string) ?? agentId;
      const callerSessionId = (ctx.meta['sessionId'] as string) ?? (ctx.session?.id ?? sessionId);

      // Auto-register this agent on first use (idempotent)
      const callerName = (ctx.meta['agentName'] as string) ?? callerId;
      const callerRole = ctx.meta['agentRole'] as string | undefined;
      try {
        await mb.registerAgent({
          agentId: callerId,
          sessionId: callerSessionId,
          name: callerName,
          role: callerRole,
          pid: process.pid,
          source: (ctx.meta['source'] as 'cli' | 'webui' | undefined) ?? 'cli',
        });
      } catch { /* best-effort */ }

      // Update heartbeat
      try {
        await mb.heartbeat({ agentId: callerId });
      } catch { /* best-effort */ }

      switch (action) {
        case 'check':
          return executeCheck(mb, callerId, i);
        case 'send':
          return executeSend(mb, callerId, callerSessionId, i);
        case 'ack':
          return executeAck(mb, callerId, i);
        case 'query':
          return executeQuery(mb, i);
        case 'status':
          return executeStatus(mb);
        case 'online':
          return executeOnline(mb);
        case 'unread':
          return executeUnread(mb, callerId);
        default:
          return { ok: false, error: `Unknown action: "${action}". Use check, send, ack, query, status, online, or unread.` };
      }
    },
  };
}

// ── Action handlers ──────────────────────────────────────────────────────

async function executeCheck(mb: Mailbox, agentId: string, i: Record<string, unknown>) {
  const limit = (i.limit as number) ?? 20;
  const messages = await mb.query({ to: agentId, unreadBy: agentId, limit, minPriority: 'low' });

  // Auto-read: add read receipt for each message
  for (const m of messages) {
    void mb.ack({ messageId: m.id, readerId: agentId, read: true }).catch(() => {});
  }

  return {
    ok: true,
    count: messages.length,
    messages: messages.map((m) => formatMessage(m, agentId)),
    summary: messages.length === 0 ? 'No unread messages.' : `${messages.length} unread message(s).`,
  };
}

async function executeSend(
  mb: Mailbox, agentId: string, _sessionId: string, i: Record<string, unknown>,
) {
  const to = i.to as string | undefined;
  const tp = i.type as string | undefined;
  const subject = i.subject as string | undefined;
  const body = i.body as string | undefined;

  if (!to) return { ok: false, error: '"to" is required.' };
  if (!tp) return { ok: false, error: '"type" is required.' };
  if (!subject) return { ok: false, error: '"subject" is required.' };
  if (!body) return { ok: false, error: '"body" is required.' };

  const msg = await mb.send({
    from: agentId,
    to, type: tp as MailboxMessageType, subject, body,
    priority: (i.priority as 'low' | 'normal' | 'high') ?? 'normal',
    replyTo: i.replyTo as string | undefined,
  });

  return {
    ok: true, messageId: msg.id, to: msg.to, type: msg.type, timestamp: msg.timestamp,
    summary: `Message sent to ${msg.to === '*' ? 'all agents' : msg.to}. Id: ${msg.id}`,
  };
}

async function executeAck(mb: Mailbox, agentId: string, i: Record<string, unknown>) {
  const messageId = i.messageId as string | undefined;
  if (!messageId) return { ok: false, error: '"messageId" is required.' };

  const updated = await mb.ack({
    messageId,
    readerId: agentId,
    read: i.read as boolean | undefined,
    completed: i.completed as boolean | undefined,
    outcome: i.outcome as string | undefined,
  });

  if (!updated) return { ok: false, error: `Message "${messageId}" not found.` };

  return {
    ok: true, messageId: updated.id,
    readBy: Object.keys(updated.readBy),
    readByCount: Object.keys(updated.readBy).length,
    completed: updated.completed,
    completedBy: updated.completedBy,
    outcome: updated.outcome,
    summary: `Message ${messageId} acknowledged. Read by ${Object.keys(updated.readBy).length} agent(s), Completed: ${updated.completed}.`,
  };
}

async function executeQuery(mb: Mailbox, i: Record<string, unknown>) {
  const limit = (i.limit as number) ?? 50;
  const messages = await mb.query({
    to: i.to as string | undefined,
    from: i.from as string | undefined,
    unreadBy: i.unreadBy as string | undefined,
    incompleteOnly: i.incompleteOnly as boolean | undefined,
    type: i.type as MailboxMessageType | undefined,
    minPriority: i.minPriority as 'low' | 'normal' | 'high' | undefined,
    since: i.since as string | undefined,
    limit,
  });
  return { ok: true, count: messages.length, messages, summary: `${messages.length} message(s).` };
}

async function executeStatus(mb: Mailbox) {
  const agents = await mb.getAgentStatuses();
  return {
    ok: true, count: agents.length,
    agents: agents.map((a) => ({
      agentId: a.agentId, name: a.name, role: a.role, sessionId: a.sessionId,
      status: a.status, currentTool: a.currentTool, currentTask: a.currentTask,
      iterations: a.iterations, toolCalls: a.toolCalls,
      lastSeenAt: a.lastSeenAt, online: a.online, pid: a.pid, source: a.source,
    })),
    summary: `${agents.filter((a) => a.online).length} online, ${agents.length} total.`,
  };
}

async function executeOnline(mb: Mailbox) {
  const agents = await mb.getOnlineAgents();
  return {
    ok: true, count: agents.length,
    agents: agents.map((a) => ({
      agentId: a.agentId, name: a.name, role: a.role, sessionId: a.sessionId,
      status: a.status, currentTool: a.currentTool, currentTask: a.currentTask,
      lastSeenAt: a.lastSeenAt, source: a.source,
    })),
    summary: `${agents.length} online agent(s).`,
  };
}

async function executeUnread(mb: Mailbox, agentId: string) {
  const count = await mb.unreadCount(agentId);
  return { ok: true, count, summary: `${count} unread message(s) for you.` };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatMessage(m: MailboxMessage, readerId: string) {
  const maxBody = 2000;
  const truncated = m.body.length > maxBody ? `${m.body.slice(0, maxBody)}… [truncated]` : m.body;
  return {
    id: m.id, from: m.from, to: m.to, type: m.type,
    subject: m.subject, body: truncated, priority: m.priority,
    readByMe: readerId in m.readBy,
    readByCount: Object.keys(m.readBy).length,
    readBy: m.readBy,
    completed: m.completed, completedBy: m.completedBy,
    outcome: m.outcome, timestamp: m.timestamp,
    replyTo: m.replyTo, senderSessionId: m.senderSessionId,
  };
}
