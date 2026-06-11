/**
 * `/mailbox` — the human operator's window into the project-level
 * inter-agent mailbox.
 *
 * Every terminal/TUI/WebUI working on the same project shares one
 * GlobalMailbox under `~/.wrongstack/projects/<slug>/_mailbox.jsonl`.
 * Agents read it automatically each iteration (mailbox-loop) and can
 * write via the `mailbox` tool; this command gives the USER the same
 * powers — see who is online, read the inbox, message a specific agent,
 * or broadcast to everyone.
 *
 * The command acts under THIS process's leader identity
 * (`leader@<sessionTag>`, session-bound), so messages you send
 * here are attributed to the same agent your conversation runs as, and
 * replies addressed to it land in your agent's next iteration.
 *
 * Usage:
 *   /mailbox                       — inbox (unread for this leader)
 *   /mailbox agents                — all registered agents on the project
 *   /mailbox online                — only agents with a live heartbeat
 *   /mailbox send <id> <message>   — direct message an agent
 *   /mailbox broadcast <message>   — message every agent ('*')
 *   /mailbox history [n]           — last n messages on the project (default 20)
 */

import * as os from 'node:os';
import * as path from 'node:path';
import {
  GlobalMailbox,
  resolveProjectDir,
  resolveMailboxIdentity,
  mailboxSessionTag,
  color,
  type MailboxAgentStatus,
  type MailboxMessage,
  type SlashCommand,
} from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

function buildMailbox(opts: SlashCommandContext): GlobalMailbox | null {
  const projectDir =
    opts.paths?.projectDir ??
    resolveProjectDir(opts.projectRoot, path.join(os.homedir(), '.wrongstack'));
  try {
    return new GlobalMailbox(projectDir);
  } catch {
    return null;
  }
}

/** The identity this session's conversation runs as (`leader@<sessionTag>`). */
function leaderId(opts: SlashCommandContext): { id: string; base: string } {
  if (opts.context) {
    const identity = resolveMailboxIdentity(opts.context);
    return { id: identity.callerId, base: identity.baseId };
  }
  return { id: `leader@${mailboxSessionTag('default')}`, base: 'leader' };
}

function fmtAgent(a: MailboxAgentStatus, selfId: string): string {
  const ageMs = Date.now() - new Date(a.lastSeenAt).getTime();
  const age = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s` : `${Math.round(ageMs / 60_000)}m`;
  const live = ageMs <= 60_000;
  const dot = live ? color.green('●') : color.dim('○');
  const self = a.agentId === selfId ? color.cyan(' (you)') : '';
  const src = a.source ? color.dim(` [${a.source}]`) : '';
  return `  ${dot} ${color.bold(a.agentId)}${self}${src}  ${color.dim(`${a.name} · ${age} ago · session ${a.sessionId}`)}`;
}

function fmtMessage(m: MailboxMessage, selfId: string): string {
  const from = m.from === selfId ? color.cyan('you') : color.bold(m.from);
  const to = m.to === '*' ? color.magenta('all') : m.to === selfId ? color.cyan('you') : m.to;
  const t = color.dim(new Date(m.timestamp).toISOString().slice(11, 19));
  const body = m.body.length > 160 ? `${m.body.slice(0, 159)}…` : m.body;
  const subject = m.subject && m.subject !== m.body ? `${color.bold(m.subject)} — ` : '';
  return `  ${t} ${from} → ${to}: ${subject}${body}`;
}

export function buildMailboxCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'mailbox',
    category: 'Agent',
    aliases: ['mb'],
    description:
      'Project-wide agent mailbox: /mailbox [agents|online|send <id> <msg>|broadcast <msg>|history [n]]',
    help: [
      'The human window into the shared inter-agent mailbox. Every terminal,',
      'TUI and WebUI on this project shares one inbox — agents see incoming',
      'messages automatically on their next iteration.',
      '',
      'Subcommands:',
      '  /mailbox                      Unread inbox for this session\'s leader.',
      '  /mailbox agents               All registered agents on the project.',
      '  /mailbox online               Only agents with a live heartbeat.',
      '  /mailbox send <id> <message>  Direct message an agent (use ids from `agents`).',
      '  /mailbox broadcast <message>  Message every agent on the project.',
      '  /mailbox history [n]          Last n messages on the project (default 20).',
      '',
      'Examples:',
      '  /mailbox broadcast pausing deploys, hold off on main',
      '  /mailbox send leader@a1b2c3d4 can you take the auth refactor?',
    ].join('\n'),
    async run(args) {
      const mb = buildMailbox(opts);
      if (!mb) return { message: color.yellow('Mailbox unavailable (no project dir).') };
      const self = leaderId(opts);

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? '';

      if (sub === 'agents' || sub === 'online') {
        const agents =
          sub === 'online' ? await mb.getOnlineAgents() : await mb.getAgentStatuses();
        if (agents.length === 0) {
          return {
            message: color.dim(
              'No agents registered yet. Agents register on their first iteration.',
            ),
          };
        }
        const lines = [
          color.bold(`${agents.length} ${sub === 'online' ? 'online ' : ''}agent(s) on this project`),
          ...agents.map((a) => fmtAgent(a, self.id)),
          '',
          color.dim(`Mailbox: ${mb.messagePath}`),
        ];
        return { message: lines.join('\n') };
      }

      if (sub === 'send') {
        const to = parts[1];
        const body = parts.slice(2).join(' ');
        if (!to || !body) return { message: 'Usage: /mailbox send <agentId> <message>' };
        const msg = await mb.send({
          from: self.id,
          to,
          type: 'note',
          subject: body.slice(0, 60),
          body,
        });
        return { message: color.green(`✓ Sent to ${to} (id ${msg.id.slice(0, 8)}…).`) };
      }

      if (sub === 'broadcast') {
        const body = parts.slice(1).join(' ');
        if (!body) return { message: 'Usage: /mailbox broadcast <message>' };
        const msg = await mb.send({
          from: self.id,
          to: '*',
          type: 'broadcast',
          subject: body.slice(0, 60),
          body,
        });
        return {
          message: color.green(
            `✓ Broadcast to all agents on the project (id ${msg.id.slice(0, 8)}…).`,
          ),
        };
      }

      if (sub === 'history') {
        const n = Number.parseInt(parts[1] ?? '20', 10) || 20;
        const messages = await mb.query({ limit: n });
        if (messages.length === 0) return { message: color.dim('No messages yet.') };
        const lines = [
          color.bold(`Last ${messages.length} message(s)`),
          // query returns newest-first; show oldest-first for reading flow.
          ...messages.reverse().map((m) => fmtMessage(m, self.id)),
        ];
        return { message: lines.join('\n') };
      }

      if (sub === '' || sub === 'inbox') {
        // Unread for the unique id AND the bare base alias ('*' matches both).
        const batches = await Promise.all([
          mb.query({ to: self.id, unreadBy: self.id, limit: 50 }).catch(() => []),
          mb.query({ to: self.base, unreadBy: self.id, limit: 50 }).catch(() => []),
        ]);
        const seen = new Set<string>();
        const unread = batches.flat().filter((m) => {
          if (seen.has(m.id) || m.from === self.id) return false;
          seen.add(m.id);
          return true;
        });
        if (unread.length === 0) {
          return {
            message: color.dim(
              `Inbox empty for ${self.id}. Try /mailbox agents or /mailbox history.`,
            ),
          };
        }
        // Mark read so the agent loop doesn't re-inject what the user saw.
        await Promise.all(
          unread.map((m) =>
            mb.ack({ messageId: m.id, readerId: self.id, read: true }).catch(() => null),
          ),
        );
        const lines = [
          color.bold(`${unread.length} unread message(s) for ${self.id}`),
          ...unread.reverse().map((m) => fmtMessage(m, self.id)),
        ];
        return { message: lines.join('\n') };
      }

      return {
        message: `Unknown subcommand "${sub}". Use: /mailbox [agents|online|send|broadcast|history]`,
      };
    },
  };
}
