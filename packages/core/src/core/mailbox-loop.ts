/**
 * mailbox-loop — Agent-loop integration for mailbox checking.
 *
 * Integrates the inter-agent mailbox into the agent's iteration cycle.
 * Before each LLM call, checks for unread high-priority messages (steer, btw).
 * Found messages are folded into the conversation so the agent can react.
 *
 * Uses the project-level GlobalMailbox for cross-session communication.
 *
 * @module mailbox-loop
 */

import type { Mailbox, MailboxMessage } from '../coordination/mailbox-types.js';

export interface MailboxLoopOptions {
  mailbox: Mailbox;
  agentId: string;
}

export function createMailboxChecker(
  opts: MailboxLoopOptions,
): () => Promise<MailboxMessage[]> {
  const { mailbox, agentId } = opts;

  const injectedIds = new Set<string>();

  return async (): Promise<MailboxMessage[]> => {
    try {
      // Query ALL unread messages (steer/btw injected inline, others summarized)
      const messages = await mailbox.query({
        to: agentId,
        unreadBy: agentId,
        limit: 10,
      });

      // Filter out already-injected and completed messages
      const fresh = messages.filter(
        (m) => !injectedIds.has(m.id) && !m.completed,
      );

      // Track as injected
      for (const m of fresh) {
        injectedIds.add(m.id);
      }

      // Auto-read all fresh messages (adds read receipt)
      for (const m of fresh) {
        void mailbox.ack({ messageId: m.id, readerId: agentId, read: true }).catch(() => {});
      }

      // GC
      if (injectedIds.size > 1000) {
        const recent = new Set([...injectedIds].slice(-500));
        injectedIds.clear();
        for (const id of recent) injectedIds.add(id);
      }

      return fresh;
    } catch {
      return [];
    }
  };
}

export function buildMailboxBlock(messages: MailboxMessage[]): { type: 'text'; text: string } {
  if (messages.length === 0) throw new Error('buildMailboxBlock called with empty messages');

  const parts: string[] = [];
  parts.push('[MAILBOX] New message(s) from other agents:');
  parts.push('');

  for (const m of messages) {
    const typeLabel =
      m.type === 'steer' ? '🔄 STEER' : m.type === 'btw' ? '💬 BTW' : `📨 ${m.type.toUpperCase()}`;
    parts.push(`--- ${typeLabel} from ${m.from} ---`);
    parts.push(`Subject: ${m.subject}`);
    parts.push('');
    parts.push(m.body);
    parts.push('');
    if (m.type === 'steer') {
      parts.push('After your current operation reaches a stopping point, adjust your approach per the instruction above.');
      parts.push('');
    }
  }

  parts.push('[END MAILBOX]');
  return { type: 'text', text: parts.join('\n') };
}

// ── Integration hooks ────────────────────────────────────────────────────
// attachMailboxChecker (which constructs the concrete GlobalMailbox) lives
// in ../mailbox-attach.ts — the composition layer — so this file stays free
// of runtime coordination/ imports (architecture Rule 3).

export async function injectPendingMailboxMessages(
  checkMailbox: () => Promise<MailboxMessage[]>,
  foldFn: (block: { type: 'text'; text: string }) => void,
  a: { events: { emit: (type: string, payload: unknown) => void }; logger: { debug?: (...args: unknown[]) => void } },
): Promise<void> {
  let messages: MailboxMessage[];
  try {
    messages = await checkMailbox();
  } catch {
    return;
  }

  // Emit events for all found messages (steer/btw go below, others get a summary)
  for (const m of messages) {
    a.events.emit('mailbox.received', {
      messageId: m.id, from: m.from, type: m.type, subject: m.subject,
    });
  }

  if (messages.length === 0) return;

  // Separate steer/btw (inject inline) from other types (summarize)
  const injectable = messages.filter((m) => m.type === 'steer' || m.type === 'btw');
  const others = messages.filter((m) => m.type !== 'steer' && m.type !== 'btw');

  if (injectable.length > 0) {
    try { foldFn(buildMailboxBlock(injectable)); } catch (err) {
      (a.logger.debug ?? console.debug)?.(
        `mailbox: failed to fold messages: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (others.length > 0) {
    const otherSubjects = others.map((m) => `  - [${m.type}] ${m.from}: ${m.subject}`).join('\n');
    const note = `[MAILBOX] You have ${others.length} other unread message(s). Use \`mailbox action=check\` to read them:\n${otherSubjects}\n[END MAILBOX]`;
    try { foldFn({ type: 'text', text: note }); } catch {
      // best-effort
    }
  }
}
