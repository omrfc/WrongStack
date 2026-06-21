export const HQ_PROTOCOL_VERSION = 1 as const;

export type HqProtocolVersion = typeof HQ_PROTOCOL_VERSION;

export type HqClientKind = 'tui' | 'repl' | 'webui' | 'cli' | 'unknown';

export type HqWorkspaceKind = 'git' | 'directory' | 'unknown';

export type HqProjectStatus = 'active' | 'idle' | 'stale' | 'error';

export type HqClientCapability =
  | 'telemetry.publish'
  | 'session.summary'
  | 'fleet.summary'
  | 'mailbox.summary'
  | 'control.receive';

export type HqToolArgsPolicy = 'none' | 'summary' | 'redacted';

export type HqPathPolicy = 'none' | 'project-relative' | 'redacted' | 'full';

export interface HqRedactionPolicy {
  rawContent: boolean;
  toolArgs: HqToolArgsPolicy;
  paths: HqPathPolicy;
}

export const DEFAULT_HQ_REDACTION_POLICY: HqRedactionPolicy = {
  rawContent: false,
  toolArgs: 'summary',
  paths: 'project-relative',
};

export interface HqClientIdentity {
  clientId: string;
  kind: HqClientKind;
  version?: string;
  machineId: string;
  hostname?: string;
  pid?: number;
  startedAt: string;
}

export interface HqProjectIdentity {
  projectId: string;
  projectRoot: string;
  projectName: string;
  gitRemote?: string;
  gitBranch?: string;
  machineId: string;
  workspaceKind: HqWorkspaceKind;
}

export interface HqClientHelloPayload {
  protocolVersion: HqProtocolVersion;
  client: HqClientIdentity;
  project: HqProjectIdentity;
  capabilities: readonly HqClientCapability[];
}

export interface HqWelcomePayload {
  type: 'hq.welcome';
  protocolVersion: HqProtocolVersion;
  serverTime: string;
  acceptedCapabilities: readonly HqClientCapability[];
  redactionPolicy: HqRedactionPolicy;
}

export interface HqEventEnvelope<TPayload = unknown> {
  id: string;
  type: HqEventType | (string & {});
  schemaVersion: HqProtocolVersion;
  timestamp: string;
  clientId: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  seq: number;
  payload: TPayload;
}

export type HqEventType =
  | 'client.hello'
  | 'client.heartbeat'
  | 'session.started'
  | 'session.status'
  | 'session.usage'
  | 'tool.started'
  | 'tool.completed'
  | 'fleet.snapshot'
  | 'fleet.event'
  | 'mailbox.snapshot'
  | 'mailbox.event'
  | 'worklist.snapshot'
  | 'git.snapshot';

export interface HqClientHeartbeatPayload {
  uptimeMs: number;
  activeSessionId?: string;
  activeRunId?: string;
  status: HqProjectStatus;
  activeSubagents?: number;
  queuedTasks?: number;
}

export type HqSessionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

export interface HqSessionStartedPayload {
  sessionId: string;
  provider?: string;
  model?: string;
  startedAt: string;
}

export interface HqSessionStatusPayload {
  status: HqSessionStatus;
  phase?: string;
  message?: string;
}

export interface HqUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface HqToolStartedPayload {
  toolName: string;
  capabilities?: readonly string[];
  risk?: string;
  inputSummary?: unknown;
}

export interface HqToolCompletedPayload {
  toolName: string;
  status: 'success' | 'error' | 'timeout' | 'cancelled';
  durationMs: number;
  outputSummary?: unknown;
  errorClass?: string;
}

export interface HqSubagentSummary {
  subagentId: string;
  role?: string;
  status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'stopped';
  task?: string;
  currentTool?: string;
  runtimeMs?: number;
  costUsd?: number;
  lastActivityAt?: string;
}

export interface HqFleetSnapshotPayload {
  runId: string;
  activeSubagents: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalCostUsd?: number;
  subagents: readonly HqSubagentSummary[];
}

export interface HqFleetEventPayload {
  runId: string;
  subagentId?: string;
  event: string;
  summary?: string;
  data?: unknown;
}

export type HqMailboxMessageType =
  | 'note'
  | 'ask'
  | 'assign'
  | 'steer'
  | 'btw'
  | 'broadcast'
  | 'status'
  | 'result'
  | 'control';

export type HqMailboxPriority = 'low' | 'normal' | 'high';

export type HqMailboxAgentStatus =
  | 'idle'
  | 'running'
  | 'streaming'
  | 'waiting_user'
  | 'error'
  | 'offline';

export interface HqMailboxMessageSummary {
  messageId: string;
  from: string;
  to: string;
  type: HqMailboxMessageType;
  subject: string;
  priority: HqMailboxPriority;
  timestamp: string;
  replyTo?: string;
  senderSessionId?: string;
  completed: boolean;
  completedBy?: string;
  completedAt?: string;
  unreadCount?: number;
  readCount?: number;
  hasBody: boolean;
  bodyPreview?: string;
  outcomePreview?: string;
  task?: {
    taskId?: string;
    agentRole?: string;
    agentName?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  };
}

export interface HqMailboxAgentSummary {
  agentId: string;
  name: string;
  role?: string;
  sessionId: string;
  status: HqMailboxAgentStatus;
  currentTool?: string;
  currentTask?: string;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
  lastSeenAt: string;
  online: boolean;
  source?: 'cli' | 'webui' | 'mcp' | 'acp';
}

export interface HqMailboxSnapshotPayload {
  mailboxId: string;
  scope: 'project' | 'global';
  messages: readonly HqMailboxMessageSummary[];
  agents: readonly HqMailboxAgentSummary[];
  totals: {
    messages: number;
    unread: number;
    incomplete: number;
    highPriority: number;
    onlineAgents: number;
  };
}

export interface HqMailboxEventPayload {
  mailboxId: string;
  action:
    | 'message.sent'
    | 'message.read'
    | 'message.completed'
    | 'message.updated'
    | 'agent.registered'
    | 'agent.heartbeat'
    | 'agent.offline';
  message?: HqMailboxMessageSummary;
  agent?: HqMailboxAgentSummary;
  summary?: string;
}

export interface HqWorklistSnapshotPayload {
  todos?: HqWorklistCounts;
  tasks?: HqWorklistCounts;
  plans?: HqWorklistCounts;
  activeItem?: string;
}

export interface HqWorklistCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed?: number;
}

export interface HqGitSnapshotPayload {
  branch?: string;
  dirtyFiles?: number;
  stagedFiles?: number;
  ahead?: number;
  behind?: number;
}

export interface HqClientRecord {
  clientId: string;
  kind: HqClientKind;
  machineId: string;
  hostname?: string;
  pid?: number;
  version?: string;
  connected: boolean;
  connectedAt?: string;
  lastSeenAt: string;
  projectId: string;
  sessionId?: string;
  capabilities: readonly HqClientCapability[];
}

export interface HqProjectRecord {
  projectId: string;
  projectName: string;
  projectRootDisplay: string;
  machineIds: readonly string[];
  gitBranch?: string;
  activeClients: number;
  activeSessions: number;
  activeSubagents: number;
  totalCostUsd: number;
  lastActivityAt: string;
  status: HqProjectStatus;
}

export interface HqSessionSummary {
  sessionId: string;
  projectId: string;
  clientId: string;
  status: HqSessionStatus;
  provider?: string;
  model?: string;
  startedAt?: string;
  lastActivityAt: string;
  costUsd?: number;
}

export interface HqFleetSummary {
  runId: string;
  projectId: string;
  clientId: string;
  activeSubagents: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalCostUsd?: number;
  lastActivityAt: string;
}

export interface HqMailboxSummary {
  mailboxId: string;
  projectId: string;
  scope: 'project' | 'global';
  messageCount: number;
  unreadCount: number;
  incompleteCount: number;
  highPriorityCount: number;
  onlineAgentCount: number;
  lastActivityAt: string;
}

export interface HqSnapshot {
  generatedAt: string;
  clients: readonly HqClientRecord[];
  projects: readonly HqProjectRecord[];
  sessions: readonly HqSessionSummary[];
  fleets: readonly HqFleetSummary[];
  mailboxes: readonly HqMailboxSummary[];
  totals: {
    activeProjects: number;
    activeClients: number;
    activeSessions: number;
    activeSubagents: number;
    unreadMailboxMessages: number;
    incompleteMailboxMessages: number;
    totalCostUsd: number;
  };
}

export interface HqBrowserSnapshotMessage {
  type: 'hq.snapshot';
  snapshot: HqSnapshot;
}

export interface HqBrowserEventMessage<TPayload = unknown> {
  type: 'hq.event';
  event: HqEventEnvelope<TPayload>;
}

export interface HqAlertMessage {
  type: 'hq.alert';
  severity: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export type HqBrowserMessage = HqBrowserSnapshotMessage | HqBrowserEventMessage | HqAlertMessage;

export interface HqClientHelloMessage {
  type: 'client.hello';
  payload: HqClientHelloPayload;
}

export interface HqClientEventMessage<TPayload = unknown> {
  type: 'client.event';
  event: HqEventEnvelope<TPayload>;
}

export interface HqClientCommandPollMessage {
  type: 'client.command_poll';
  clientId: string;
  projectId: string;
  afterCommandId?: string;
  limit?: number;
}

export interface HqClientCommandAckMessage {
  type: 'client.command_ack';
  clientId: string;
  projectId: string;
  commandId: string;
  status: 'accepted' | 'completed' | 'failed' | 'rejected';
  message?: string;
}

export interface HqQueuedCommand {
  commandId: string;
  type: string;
  createdAt: string;
  payload: unknown;
  requiresAck?: boolean;
}

export interface HqServerCommandBatchMessage {
  type: 'hq.command_batch';
  commands: readonly HqQueuedCommand[];
}

export type HqClientMessage =
  | HqClientHelloMessage
  | HqClientEventMessage
  | HqClientCommandPollMessage
  | HqClientCommandAckMessage;

export type HqServerMessage = HqServerCommandBatchMessage | HqWelcomePayload;

/**
 * Discriminated parse result for {@link parseHqFrame}. The `reason` field
 * is only present when `ok` is `false`; consumers should narrow on `ok`
 * before accessing `frame` or `reason`.
 */
export type HqParseResult =
  | { ok: true; frame: HqClientMessage }
  | { ok: false; reason: 'invalid-json' | 'unknown-type' | 'malformed' };

/** Known client → server frame `type` discriminators. */
const KNOWN_HQ_CLIENT_FRAME_TYPES = new Set<HqClientMessage['type']>([
  'client.hello',
  'client.event',
  'client.command_poll',
  'client.command_ack',
]);

/** Top-level object + string `type` guard. */
function hasStringType(x: unknown): x is { type: string } {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}

function isHqClientIdentity(x: unknown): x is HqClientIdentity {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.clientId === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.machineId === 'string' &&
    typeof v.startedAt === 'string'
  );
}

function isHqProjectIdentity(x: unknown): x is HqProjectIdentity {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.projectId === 'string' &&
    typeof v.projectRoot === 'string' &&
    typeof v.projectName === 'string' &&
    typeof v.machineId === 'string' &&
    typeof v.workspaceKind === 'string'
  );
}

function isHqClientHelloPayload(x: unknown): x is HqClientHelloPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.protocolVersion === 'number' &&
    isHqClientIdentity(v.client) &&
    isHqProjectIdentity(v.project) &&
    Array.isArray(v.capabilities)
  );
}

function isHqEventEnvelope(x: unknown): x is HqEventEnvelope {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.type === 'string' &&
    typeof v.schemaVersion === 'number' &&
    typeof v.timestamp === 'string' &&
    typeof v.clientId === 'string' &&
    typeof v.projectId === 'string' &&
    typeof v.seq === 'number'
  );
}

function isHqClientCommandPollMessage(x: unknown): x is HqClientCommandPollMessage {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return typeof v.clientId === 'string' && typeof v.projectId === 'string';
}

function isHqClientCommandAckMessage(x: unknown): x is HqClientCommandAckMessage {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.clientId === 'string' &&
    typeof v.projectId === 'string' &&
    typeof v.commandId === 'string' &&
    typeof v.status === 'string'
  );
}

/**
 * Strictly parse a raw client → server frame into a {@link HqParseResult}.
 *
 * Validates, in order:
 *  1. JSON syntax (`invalid-json` on failure)
 *  2. Top-level object with string `type` discriminator
 *  3. `type` is one of {@link HqClientMessage} union members (`unknown-type`)
 *  4. Per-type field-shape presence checks (`malformed` on failure)
 *
 * On success, `frame` is narrowed to {@link HqClientMessage} and consumers
 * can switch on `frame.type` for type-safe access to per-union-member
 * fields without `as` casts.
 */
export function parseHqFrame(raw: string | Buffer): HqParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  if (!hasStringType(parsed)) {
    return { ok: false, reason: 'malformed' };
  }
  const obj = parsed as { type: string } & Record<string, unknown>;

  if (!KNOWN_HQ_CLIENT_FRAME_TYPES.has(obj.type as HqClientMessage['type'])) {
    return { ok: false, reason: 'unknown-type' };
  }

  switch (obj.type as HqClientMessage['type']) {
    case 'client.hello':
      if (!isHqClientHelloPayload(obj.payload)) {
        return { ok: false, reason: 'malformed' };
      }
      return { ok: true, frame: { type: 'client.hello', payload: obj.payload } };
    case 'client.event':
      if (!isHqEventEnvelope(obj.event)) {
        return { ok: false, reason: 'malformed' };
      }
      return { ok: true, frame: { type: 'client.event', event: obj.event } };
    case 'client.command_poll':
      if (!isHqClientCommandPollMessage(obj)) {
        return { ok: false, reason: 'malformed' };
      }
      return {
        ok: true,
        frame: { type: 'client.command_poll', clientId: obj.clientId, projectId: obj.projectId },
      };
    case 'client.command_ack':
      if (!isHqClientCommandAckMessage(obj)) {
        return { ok: false, reason: 'malformed' };
      }
      return {
        ok: true,
        frame: {
          type: 'client.command_ack',
          clientId: obj.clientId,
          projectId: obj.projectId,
          commandId: obj.commandId,
          status: obj.status as HqClientCommandAckMessage['status'],
        },
      };
    default: {
      // Unreachable: KNOWN_HQ_CLIENT_FRAME_TYPES membership guarantees
      // `obj.type` is one of the cases above. Return `unknown-type` defensively
      // to satisfy the return type if a future HqClientMessage union member
      // is added without updating this switch.
      const _exhaustive: never = obj.type as never;
      return _exhaustive;
    }
  }
}

/** Known `client.event` envelope event types whose payload shape we validate. */
const KNOWN_HQ_EVENT_PAYLOAD_TYPES = new Set<string>(['mailbox.snapshot', 'mailbox.event']);

function isHqMailboxMessageSummary(x: unknown): x is HqMailboxMessageSummary {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.messageId === 'string' &&
    typeof v.from === 'string' &&
    typeof v.to === 'string' &&
    typeof v.subject === 'string' &&
    typeof v.priority === 'string' &&
    typeof v.timestamp === 'string' &&
    typeof v.completed === 'boolean' &&
    typeof v.hasBody === 'boolean'
  );
}

function isHqMailboxAgentSummary(x: unknown): x is HqMailboxAgentSummary {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.agentId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.status === 'string' &&
    typeof v.iterations === 'number' &&
    typeof v.toolCalls === 'number' &&
    typeof v.lastActivityAt === 'string' &&
    typeof v.lastSeenAt === 'string' &&
    typeof v.online === 'boolean'
  );
}

function isHqMailboxSnapshotPayload(x: unknown): x is HqMailboxSnapshotPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (
    typeof v.mailboxId !== 'string' ||
    (v.scope !== 'project' && v.scope !== 'global') ||
    !Array.isArray(v.messages) ||
    !Array.isArray(v.agents) ||
    typeof v.totals !== 'object' ||
    v.totals === null
  ) {
    return false;
  }
  const totals = v.totals as Record<string, unknown>;
  if (
    typeof totals.messages !== 'number' ||
    typeof totals.unread !== 'number' ||
    typeof totals.incomplete !== 'number' ||
    typeof totals.highPriority !== 'number' ||
    typeof totals.onlineAgents !== 'number'
  ) {
    return false;
  }
  for (const message of v.messages) {
    if (!isHqMailboxMessageSummary(message)) return false;
  }
  for (const agent of v.agents) {
    if (!isHqMailboxAgentSummary(agent)) return false;
  }
  return true;
}

const HQ_MAILBOX_EVENT_ACTIONS = new Set<string>([
  'message.sent',
  'message.read',
  'message.completed',
  'message.updated',
  'agent.registered',
  'agent.heartbeat',
  'agent.offline',
]);

function isHqMailboxEventPayload(x: unknown): x is HqMailboxEventPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (typeof v.mailboxId !== 'string') return false;
  if (typeof v.action !== 'string' || !HQ_MAILBOX_EVENT_ACTIONS.has(v.action)) return false;
  // `message` and `agent` are optional but, when present, must satisfy
  // their respective shape guard so a downstream consumer can rely on
  // the typed fields.
  if (v.message !== undefined && !isHqMailboxMessageSummary(v.message)) return false;
  if (v.agent !== undefined && !isHqMailboxAgentSummary(v.agent)) return false;
  return true;
}

/**
 * Validate the `payload` field of a {@link HqEventEnvelope} for known
 * event types. Returns `{ ok: true, payload }` with a narrowed payload
 * type when the event type has a registered shape guard and the payload
 * matches it; `{ ok: true, payload: unknown }` for event types that the
 * server does not yet validate; or `{ ok: false, reason }` when the
 * payload fails the registered guard.
 *
 * Use this after {@link parseHqFrame} has produced a valid frame, when
 * the frame is `client.event` and the server is about to consume the
 * event payload.
 */
export type HqEventPayloadResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: 'unknown-event-type' | 'malformed-payload' };

export function parseHqEventPayload(
  eventType: string,
  payload: unknown,
): HqEventPayloadResult<unknown> {
  if (!KNOWN_HQ_EVENT_PAYLOAD_TYPES.has(eventType)) {
    // Server does not validate this event type yet — pass it through
    // untyped so the publish pipeline is not blocked. Future events
    // can opt-in by adding their type + guard here.
    return { ok: true, payload };
  }
  switch (eventType) {
    case 'mailbox.snapshot':
      return isHqMailboxSnapshotPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'mailbox.event':
      return isHqMailboxEventPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    default: {
      const _exhaustive: never = eventType as never;
      return _exhaustive;
    }
  }
}

export function createHqEventEnvelope<TPayload>(input: {
  id: string;
  type: HqEventType | (string & {});
  timestamp: string;
  clientId: string;
  projectId: string;
  seq: number;
  payload: TPayload;
  sessionId?: string;
  runId?: string;
}): HqEventEnvelope<TPayload> {
  return {
    id: input.id,
    type: input.type,
    schemaVersion: HQ_PROTOCOL_VERSION,
    timestamp: input.timestamp,
    clientId: input.clientId,
    projectId: input.projectId,
    seq: input.seq,
    payload: input.payload,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
  };
}
