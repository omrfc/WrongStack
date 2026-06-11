/**
 * mail-tools — thin, high-affordance wrappers over the project mailbox.
 *
 * The multi-action `mailbox` tool is the power surface; these two exist
 * because explicit verbs ("send a mail", "read my inbox") are what makes
 * agents USE the mailbox autonomously — a model reaches for `mail_send`
 * mid-task far more readily than for `mailbox action=send ...`.
 *
 *   mail_send  — message one agent (`to: "leader@a1b2c3d4"`), every leader
 *                (`to: "leader"`), or everyone (`to: "*"`)
 *   mail_inbox — read unread mail (unique id + base alias + broadcasts),
 *                marking it read so it isn't re-injected next iteration
 *
 * Both share the identity convention with the agent-loop checker
 * (`<base>@<sessionTag>`, see mailbox-attach) via `resolveMailboxIdentity`.
 *
 * @module mail-tools
 */

import type { EventBus } from '../kernel/events.js';
import type { Context } from '../core/context.js';
import type { Tool } from '../types/tool.js';
import { GlobalMailbox } from './global-mailbox.js';
import type { Mailbox, MailboxMessage, MailboxMessageType } from './mailbox-types.js';
import {
  defaultResolveProjectDir,
  resolveMailboxIdentity,
  type MailboxResolver,
} from './mailbox-tool.js';

export interface MailToolsOptions {
  /** How to obtain a Mailbox given the execution Context (tests). */
  resolveMailbox?: MailboxResolver | undefined;
  /** Project dir for the shared mailbox. Prefer wpaths.projectDir. */
  projectDir?: string | undefined;
  /** EventBus for mailbox.agent_registered / heartbeat surface events. */
  events?: EventBus | undefined;
}

function makeResolver(opts: MailToolsOptions): MailboxResolver {
  return (
    opts.resolveMailbox ??
    ((ctx: Context) =>
      new GlobalMailbox(opts.projectDir ?? defaultResolveProjectDir(ctx), opts.events))
  );
}

async function register(mb: Mailbox, ctx: Context): Promise<ReturnType<typeof resolveMailboxIdentity>> {
  const identity = resolveMailboxIdentity(ctx);
  try {
    await mb.registerAgent({
      agentId: identity.callerId,
      sessionId: identity.sessionId,
      name: identity.name,
      role: identity.role,
      pid: process.pid,
      source: (ctx.meta['source'] as 'cli' | 'webui' | undefined) ?? 'cli',
    });
    await mb.heartbeat({ agentId: identity.callerId });
  } catch {
    /* best-effort */
  }
  return identity;
}

export function makeMailSendTool(opts: MailToolsOptions = {}): Tool {
  const resolveMailbox = makeResolver(opts);
  return {
    name: 'mail_send',
    description:
      'Send a mail to other agents working on this project (other terminals, TUIs, WebUIs). ' +
      'Use it to hand off work ("can you review src/auth.ts?"), ask questions, or announce ' +
      'what you just did. to="*" broadcasts to everyone; to="leader" reaches every leader ' +
      'process; an exact id like "leader@a1b2c3d4" reaches one agent. Recipients see your mail ' +
      'automatically before their next step.',
    usageHint: 'mail_send to="*" subject="auth refactor done" body="touched src/auth/*, please review"',
    category: 'coordination',
    permission: 'auto',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient: exact agent id ("leader@a1b2c3d4"), base alias ("leader"), or "*" for everyone.',
        },
        subject: { type: 'string', description: 'Short subject line.' },
        body: { type: 'string', description: 'The message.' },
        type: {
          type: 'string',
          enum: ['note', 'ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result'],
          description: 'Message intent. Default: "broadcast" when to="*", otherwise "note".',
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        replyTo: { type: 'string', description: 'Message id this replies to.' },
      },
      required: ['to', 'subject', 'body'],
    },
    async execute(input: unknown, ctx: Context) {
      const i = (input ?? {}) as Record<string, unknown>;
      const to = i.to as string | undefined;
      const subject = i.subject as string | undefined;
      const body = i.body as string | undefined;
      if (!to || !subject || body === undefined || body === null) {
        return { ok: false, error: '"to", "subject" and "body" are required.' };
      }
      const mb = resolveMailbox(ctx);
      const identity = await register(mb, ctx);
      const type = (i.type as MailboxMessageType | undefined) ?? (to === '*' ? 'broadcast' : 'note');
      const msg = await mb.send({
        from: identity.callerId,
        to,
        type,
        subject,
        body,
        priority: (i.priority as 'low' | 'normal' | 'high' | undefined) ?? 'normal',
        replyTo: i.replyTo as string | undefined,
      });
      return {
        ok: true,
        messageId: msg.id,
        from: identity.callerId,
        to: msg.to,
        summary: `Mail sent to ${msg.to === '*' ? 'all agents' : msg.to} as ${identity.callerId}.`,
      };
    },
  };
}

export function makeMailInboxTool(opts: MailToolsOptions = {}): Tool {
  const resolveMailbox = makeResolver(opts);
  return {
    name: 'mail_inbox',
    description:
      'Read your unread mail from other agents on this project and mark it read. Covers mail ' +
      'addressed to you directly, to your base name (e.g. "leader"), and broadcasts ("*"). ' +
      'Urgent steer/btw mail is already injected automatically — use this to catch up on ' +
      'notes, questions, handoffs and results, or after a long stretch of tool work.',
    usageHint: 'mail_inbox  (optionally: limit=10, markRead=false to peek)',
    category: 'coordination',
    permission: 'auto',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default 20).' },
        markRead: {
          type: 'boolean',
          description: 'Add a read receipt for each returned message (default true).',
        },
      },
    },
    async execute(input: unknown, ctx: Context) {
      const i = (input ?? {}) as Record<string, unknown>;
      const limit = (i.limit as number | undefined) ?? 20;
      const markRead = (i.markRead as boolean | undefined) ?? true;
      const mb = resolveMailbox(ctx);
      const identity = await register(mb, ctx);

      const targets = [identity.callerId];
      if (identity.baseId !== identity.callerId) targets.push(identity.baseId);
      const batches = await Promise.all(
        targets.map((to) =>
          mb
            .query({ to, unreadBy: identity.callerId, limit })
            .catch(() => [] as MailboxMessage[]),
        ),
      );
      const seen = new Set<string>();
      const messages = batches
        .flat()
        .filter((m) => {
          if (seen.has(m.id) || m.from === identity.callerId) return false;
          seen.add(m.id);
          return true;
        })
        .slice(0, limit);

      if (markRead) {
        await Promise.all(
          messages.map((m) =>
            mb.ack({ messageId: m.id, readerId: identity.callerId, read: true }).catch(() => null),
          ),
        );
      }

      return {
        ok: true,
        you: identity.callerId,
        count: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          type: m.type,
          subject: m.subject,
          body: m.body.length > 2000 ? `${m.body.slice(0, 2000)}… [truncated]` : m.body,
          timestamp: m.timestamp,
          replyTo: m.replyTo,
        })),
        summary:
          messages.length === 0
            ? 'Inbox empty.'
            : `${messages.length} unread message(s)${markRead ? ' (marked read)' : ''}. Reply with mail_send using the sender id.`,
      };
    },
  };
}
