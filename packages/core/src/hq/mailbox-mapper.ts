import type { Mailbox, MailboxAgentStatus, MailboxMessage } from '../coordination/mailbox-types.js';
import type {
  HqMailboxAgentSummary,
  HqMailboxEventPayload,
  HqMailboxMessageSummary,
  HqMailboxSnapshotPayload,
  HqRedactionPolicy,
} from './protocol.js';
import { redactHqValue } from './redaction.js';

export interface HqMailboxMappingOptions {
  mailboxId: string;
  scope?: 'project' | 'global';
  limit?: number;
  previewLength?: number;
  redactionPolicy?: Partial<HqRedactionPolicy>;
}

export interface HqMailboxSnapshotOptions extends HqMailboxMappingOptions {
  includeCompleted?: boolean;
}

export type HqMailboxEventAction = HqMailboxEventPayload['action'];

function previewText(value: string | undefined, maxLength: number, policy?: Partial<HqRedactionPolicy>): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const redacted = redactHqValue(value, { maxSummaryLength: maxLength, policy: { rawContent: true, ...policy } }).value;
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}…`;
}

function readCount(message: MailboxMessage): number {
  return Object.keys(message.readBy).length;
}

function taskSummary(message: MailboxMessage): HqMailboxMessageSummary['task'] {
  if (message.taskContext === undefined) return undefined;
  const task = {
    ...(message.taskContext.taskId !== undefined ? { taskId: message.taskContext.taskId } : {}),
    ...(message.taskContext.agentRole !== undefined ? { agentRole: message.taskContext.agentRole } : {}),
    ...(message.taskContext.agentName !== undefined ? { agentName: message.taskContext.agentName } : {}),
    ...(message.taskContext.status !== undefined ? { status: message.taskContext.status } : {}),
  } satisfies HqMailboxMessageSummary['task'];
  return Object.keys(task).length > 0 ? task : undefined;
}

export function mapMailboxMessageToHqSummary(
  message: MailboxMessage,
  options: Pick<HqMailboxMappingOptions, 'previewLength' | 'redactionPolicy'> = {},
): HqMailboxMessageSummary {
  const previewLength = options.previewLength ?? 160;
  const bodyPreview = previewText(message.body, previewLength, options.redactionPolicy);
  const outcomePreview = previewText(message.outcome, previewLength, options.redactionPolicy);
  const task = taskSummary(message);

  return {
    mailId: message.id, // unique UUID per message record, used for deduplication
    messageId: message.id,
    from: message.from,
    to: message.to,
    type: message.type,
    subject: previewText(message.subject, previewLength, options.redactionPolicy) ?? '',
    priority: message.priority,
    timestamp: message.timestamp,
    ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    ...(message.senderSessionId !== undefined ? { senderSessionId: message.senderSessionId } : {}),
    completed: message.completed,
    ...(message.completedBy !== undefined ? { completedBy: message.completedBy } : {}),
    ...(message.completedAt !== undefined ? { completedAt: message.completedAt } : {}),
    readCount: readCount(message),
    hasBody: message.body.length > 0,
    ...(bodyPreview !== undefined ? { bodyPreview } : {}),
    ...(outcomePreview !== undefined ? { outcomePreview } : {}),
    ...(task !== undefined ? { task } : {}),
  };
}

export function mapMailboxAgentToHqSummary(agent: MailboxAgentStatus): HqMailboxAgentSummary {
  return {
    agentId: agent.agentId,
    name: agent.name,
    ...(agent.role !== undefined ? { role: agent.role } : {}),
    sessionId: agent.sessionId,
    status: agent.status,
    ...(agent.currentTool !== undefined ? { currentTool: agent.currentTool } : {}),
    ...(agent.currentTask !== undefined ? { currentTask: agent.currentTask } : {}),
    iterations: agent.iterations,
    toolCalls: agent.toolCalls,
    lastActivityAt: agent.lastActivityAt,
    lastSeenAt: agent.lastSeenAt,
    online: agent.online,
    ...(agent.source !== undefined ? { source: agent.source } : {}),
  };
}

export function createMailboxSnapshotPayload(
  messages: readonly MailboxMessage[],
  agents: readonly MailboxAgentStatus[],
  options: HqMailboxSnapshotOptions,
): HqMailboxSnapshotPayload {
  const includeCompleted = options.includeCompleted ?? true;
  const filteredMessages = includeCompleted ? messages : messages.filter((message) => !message.completed);
  const limit = options.limit ?? 50;
  const sortedMessages = [...filteredMessages].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  const summaries = sortedMessages.map((message) => mapMailboxMessageToHqSummary(message, options));
  const agentSummaries = agents.map(mapMailboxAgentToHqSummary);

  return {
    mailboxId: options.mailboxId,
    scope: options.scope ?? 'project',
    messages: summaries,
    agents: agentSummaries,
    totals: {
      messages: messages.length,
      unread: messages.filter((message) => !message.completed && readCount(message) === 0).length,
      incomplete: messages.filter((message) => !message.completed).length,
      highPriority: messages.filter((message) => message.priority === 'high').length,
      onlineAgents: agents.filter((agent) => agent.online).length,
    },
  };
}

export async function createMailboxSnapshotPayloadFromMailbox(
  mailbox: Pick<Mailbox, 'query' | 'getAgentStatuses'>,
  options: HqMailboxSnapshotOptions,
): Promise<HqMailboxSnapshotPayload> {
  const limit = options.limit ?? 50;
  const [messages, agents] = await Promise.all([
    mailbox.query({ limit }),
    mailbox.getAgentStatuses(),
  ]);
  return createMailboxSnapshotPayload(messages, agents, options);
}

export function createMailboxEventPayload(input: {
  mailboxId: string;
  action: HqMailboxEventAction;
  message?: MailboxMessage;
  agent?: MailboxAgentStatus;
  summary?: string;
  previewLength?: number;
  redactionPolicy?: Partial<HqRedactionPolicy>;
}): HqMailboxEventPayload {
  const summaryOptions: Pick<HqMailboxMappingOptions, 'previewLength' | 'redactionPolicy'> = {
    ...(input.previewLength !== undefined ? { previewLength: input.previewLength } : {}),
    ...(input.redactionPolicy !== undefined ? { redactionPolicy: input.redactionPolicy } : {}),
  };

  return {
    mailboxId: input.mailboxId,
    action: input.action,
    ...(input.message !== undefined ? { message: mapMailboxMessageToHqSummary(input.message, summaryOptions) } : {}),
    ...(input.agent !== undefined ? { agent: mapMailboxAgentToHqSummary(input.agent) } : {}),
    ...(input.summary !== undefined
      ? { summary: previewText(input.summary, input.previewLength ?? 160, input.redactionPolicy) ?? '' }
      : {}),
  };
}
