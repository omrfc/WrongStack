import { create } from 'zustand';

// ============================================
// Mailbox Store
// ============================================
// Central cache of mailbox messages + agent roster. Populated by the
// ws-handlers ('mailbox.messages' / 'mailbox.agents' responses) so the
// ActivityBar unread badge works even while MailboxPanel is unmounted.

export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  subject: string;
  body: string;
  priority: string;
  readBy: Record<string, string>;
  /** Count of agents who have marked this message as read. */
  readByCount: number;
  completed: boolean;
  completedBy?: string;
  completedAt?: string;
  outcome?: string;
  timestamp: string;
  senderSessionId?: string;
  /** ID of the message this is a reply to, if any. */
  replyTo?: string;
  /** Free-form task context attached to the message by the sender. */
  taskContext?: string;
}

export interface MailboxAgent {
  agentId: string;
  name: string;
  role?: string;
  sessionId: string;
  status: string;
  currentTool?: string;
  currentTask?: string;
  lastSeenAt: string;
  online: boolean;
  source?: string;
  /** Process ID of the agent subprocess, if tracked. */
  pid?: number;
  /** Number of iterations the agent has run. */
  iterations?: number;
  /** Number of tool calls the agent has made in the current iteration. */
  toolCalls?: number;
}

interface MailboxState {
  messages: MailboxMessage[];
  agents: MailboxAgent[];
  setMessages: (messages: MailboxMessage[]) => void;
  setAgents: (agents: MailboxAgent[]) => void;
}

export const useMailboxStore = create<MailboxState>()((set) => ({
  messages: [],
  agents: [],
  setMessages: (messages) => set({ messages }),
  setAgents: (agents) => set({ agents }),
}));

/** Incomplete messages where no agent has acted yet (readByCount === 0).
 *  Driven by `incompleteOnly: true` query — the server filters to active
 *  messages, so anything with readByCount === 0 is genuinely unread. */
export function selectUnreadCount(s: MailboxState): number {
  return s.messages.filter((m) => !m.completed && (m.readByCount ?? 0) === 0).length;
}
