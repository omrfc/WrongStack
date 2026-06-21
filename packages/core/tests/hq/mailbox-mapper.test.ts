import { describe, expect, it } from 'vitest';
import type { Mailbox, MailboxAgentStatus, MailboxMessage } from '../../src/coordination/mailbox-types.js';
import {
  createMailboxEventPayload,
  createMailboxSnapshotPayload,
  createMailboxSnapshotPayloadFromMailbox,
  mapMailboxAgentToHqSummary,
  mapMailboxMessageToHqSummary,
} from '../../src/hq/mailbox-mapper.js';

const baseMessage: MailboxMessage = {
  id: 'msg_1',
  from: 'leader@a',
  to: '*',
  type: 'assign',
  subject: 'Review auth flow',
  body: 'Use Bearer abcdefghijklmnopqrstuvwxyz while reproducing the issue.',
  priority: 'high',
  readBy: { 'agent@b': '2026-06-21T12:01:00.000Z' },
  completed: false,
  timestamp: '2026-06-21T12:00:00.000Z',
  senderSessionId: 'session_1',
  taskContext: {
    taskId: 'task_1',
    agentRole: 'security-scanner',
    agentName: 'Security Scanner',
    status: 'pending',
  },
};

const baseAgent: MailboxAgentStatus = {
  agentId: 'agent@b',
  name: 'Security Scanner',
  role: 'security-scanner',
  sessionId: 'session_2',
  status: 'running',
  currentTool: 'grep',
  currentTask: 'Review auth flow',
  iterations: 4,
  toolCalls: 12,
  lastActivityAt: '2026-06-21T12:02:00.000Z',
  lastSeenAt: '2026-06-21T12:02:00.000Z',
  online: true,
  pid: 123,
  source: 'cli',
};

describe('HQ mailbox mapper', () => {
  it('maps mailbox messages to safe HQ summaries', () => {
    const summary = mapMailboxMessageToHqSummary(baseMessage, { previewLength: 120 });

    expect(summary).toMatchObject({
      messageId: 'msg_1',
      from: 'leader@a',
      to: '*',
      type: 'assign',
      subject: 'Review auth flow',
      priority: 'high',
      completed: false,
      readCount: 1,
      hasBody: true,
      senderSessionId: 'session_1',
      task: {
        taskId: 'task_1',
        agentRole: 'security-scanner',
        agentName: 'Security Scanner',
        status: 'pending',
      },
    });
    expect(summary.bodyPreview).toContain('[REDACTED:bearer_token]');
    expect(summary.bodyPreview).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect('body' in summary).toBe(false);
  });

  it('maps mailbox agent status to HQ agent summary', () => {
    expect(mapMailboxAgentToHqSummary(baseAgent)).toEqual({
      agentId: 'agent@b',
      name: 'Security Scanner',
      role: 'security-scanner',
      sessionId: 'session_2',
      status: 'running',
      currentTool: 'grep',
      currentTask: 'Review auth flow',
      iterations: 4,
      toolCalls: 12,
      lastActivityAt: '2026-06-21T12:02:00.000Z',
      lastSeenAt: '2026-06-21T12:02:00.000Z',
      online: true,
      source: 'cli',
    });
  });

  it('creates project mailbox snapshots with aggregate counts', () => {
    const completedMessage: MailboxMessage = {
      ...baseMessage,
      id: 'msg_2',
      priority: 'normal',
      completed: true,
      completedBy: 'agent@b',
      completedAt: '2026-06-21T12:03:00.000Z',
      outcome: 'Done with SECRET_TOKEN=abcdefghijklmnopqrstuvwxyz123456',
      readBy: {},
    };

    const snapshot = createMailboxSnapshotPayload([baseMessage, completedMessage], [baseAgent], {
      mailboxId: 'project_1:mailbox',
    });

    expect(snapshot.mailboxId).toBe('project_1:mailbox');
    expect(snapshot.scope).toBe('project');
    expect(snapshot.totals).toEqual({
      messages: 2,
      unread: 0,
      incomplete: 1,
      highPriority: 1,
      onlineAgents: 1,
    });
    expect(snapshot.messages).toHaveLength(2);
    const completedSummary = snapshot.messages.find((message) => message.messageId === 'msg_2');
    expect(completedSummary?.outcomePreview).toContain('[REDACTED:high_entropy_env]');
  });

  it('creates mailbox snapshots from the mailbox API', async () => {
    const mailbox = {
      query: async () => [baseMessage],
      getAgentStatuses: async () => [baseAgent],
    } satisfies Pick<Mailbox, 'query' | 'getAgentStatuses'>;

    const snapshot = await createMailboxSnapshotPayloadFromMailbox(mailbox, {
      mailboxId: 'project_1:mailbox',
      limit: 25,
    });

    expect(snapshot.messages[0]?.messageId).toBe('msg_1');
    expect(snapshot.agents[0]?.agentId).toBe('agent@b');
  });

  it('creates mailbox event payloads for message updates', () => {
    const payload = createMailboxEventPayload({
      mailboxId: 'project_1:mailbox',
      action: 'message.sent',
      message: baseMessage,
      summary: 'Sent mailbox body with Bearer abcdefghijklmnopqrstuvwxyz',
    });

    expect(payload.action).toBe('message.sent');
    expect(payload.message?.messageId).toBe('msg_1');
    expect(payload.summary).toContain('[REDACTED:bearer_token]');
  });
});
