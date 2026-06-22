import { describe, expect, it } from 'vitest';
import {
  createHqEventEnvelope,
  DEFAULT_HQ_REDACTION_POLICY,
  HQ_PROTOCOL_VERSION,
  type HqMailboxSnapshotPayload,
  type HqSnapshot,
  parseHqEventPayload,
  parseHqFrame,
} from '../../src/hq/protocol.js';

describe('HQ protocol', () => {
  it('creates versioned event envelopes with optional ids omitted when absent', () => {
    const event = createHqEventEnvelope({
      id: 'evt_1',
      type: 'session.status',
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      seq: 42,
      payload: { status: 'running' },
    });

    expect(event).toEqual({
      id: 'evt_1',
      type: 'session.status',
      schemaVersion: HQ_PROTOCOL_VERSION,
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      seq: 42,
      payload: { status: 'running' },
    });
    expect('sessionId' in event).toBe(false);
    expect('runId' in event).toBe(false);
  });

  it('includes optional session and run ids when provided', () => {
    const event = createHqEventEnvelope({
      id: 'evt_2',
      type: 'fleet.snapshot',
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      sessionId: 'session_1',
      runId: 'run_1',
      seq: 1,
      payload: { activeSubagents: 2 },
    });

    expect(event.sessionId).toBe('session_1');
    expect(event.runId).toBe('run_1');
  });

  it('supports mailbox snapshot events as first-class cross-project telemetry', () => {
    const payload: HqMailboxSnapshotPayload = {
      mailboxId: 'project_1:mailbox',
      scope: 'project',
      messages: [
        {
          messageId: 'msg_1',
          from: 'leader@a',
          to: '*',
          type: 'status',
          subject: 'Fleet done',
          priority: 'normal',
          timestamp: '2026-06-21T12:00:00.000Z',
          completed: false,
          unreadCount: 2,
          readCount: 1,
          hasBody: true,
          bodyPreview: 'Completed the HQ protocol phase',
        },
      ],
      agents: [
        {
          agentId: 'leader@a',
          name: 'Leader',
          sessionId: 'session_1',
          status: 'running',
          iterations: 3,
          toolCalls: 10,
          lastActivityAt: '2026-06-21T12:00:00.000Z',
          lastSeenAt: '2026-06-21T12:00:00.000Z',
          online: true,
          source: 'cli',
        },
      ],
      totals: {
        messages: 1,
        unread: 2,
        incomplete: 1,
        highPriority: 0,
        onlineAgents: 1,
      },
    };

    const event = createHqEventEnvelope({
      id: 'evt_mailbox_1',
      type: 'mailbox.snapshot',
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      seq: 3,
      payload,
    });

    expect(event.type).toBe('mailbox.snapshot');
    expect(event.payload.totals.unread).toBe(2);
    expect(event.payload.messages[0]?.bodyPreview).toBe('Completed the HQ protocol phase');
  });

  it('includes mailbox rollups in the global snapshot shape', () => {
    const snapshot: HqSnapshot = {
      generatedAt: '2026-06-21T12:00:00.000Z',
      clients: [],
      projects: [],
      sessions: [],
      fleets: [],
      mailboxes: [
        {
          mailboxId: 'project_1:mailbox',
          projectId: 'project_1',
          scope: 'project',
          messageCount: 5,
          unreadCount: 2,
          incompleteCount: 1,
          highPriorityCount: 1,
          onlineAgentCount: 3,
          lastActivityAt: '2026-06-21T12:00:00.000Z',
        },
      ],
      totals: {
        activeProjects: 1,
        activeClients: 1,
        activeSessions: 0,
        activeSubagents: 0,
        unreadMailboxMessages: 2,
        incompleteMailboxMessages: 1,
        totalCostUsd: 0,
      },
    };

    expect(snapshot.mailboxes[0]?.unreadCount).toBe(2);
    expect(snapshot.totals.incompleteMailboxMessages).toBe(1);
  });

  it('defaults to safe HQ redaction policy', () => {
    expect(DEFAULT_HQ_REDACTION_POLICY).toEqual({
      rawContent: false,
      toolArgs: 'summary',
      paths: 'project-relative',
    });
  });
});

describe('parseHqFrame', () => {
  const validHello = {
    type: 'client.hello',
    payload: {
      protocolVersion: HQ_PROTOCOL_VERSION,
      client: {
        clientId: 'cli_1',
        kind: 'tui',
        machineId: 'm_1',
        startedAt: '2026-06-21T00:00:00.000Z',
      },
      project: {
        projectId: 'p_1',
        projectRoot: '/tmp/proj',
        projectName: 'proj',
        machineId: 'm_1',
        workspaceKind: 'git',
      },
      capabilities: ['telemetry.publish'],
    },
  };

  it('parses a valid client.hello frame with narrow-typed payload', () => {
    const result = parseHqFrame(JSON.stringify(validHello));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('client.hello');
    if (result.frame.type !== 'client.hello') return;
    expect(result.frame.payload.protocolVersion).toBe(HQ_PROTOCOL_VERSION);
    expect(result.frame.payload.client.clientId).toBe('cli_1');
    expect(result.frame.payload.capabilities).toEqual(['telemetry.publish']);
  });

  it('parses a valid client.event frame with the embedded HqEventEnvelope', () => {
    const event = {
      type: 'client.event',
      event: {
        id: 'evt_1',
        type: 'mailbox.snapshot',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: '2026-06-21T00:00:00.000Z',
        clientId: 'cli_1',
        projectId: 'p_1',
        seq: 1,
        payload: { mailboxId: 'm_1', messages: [], agents: [], totals: {} },
      },
    };
    const result = parseHqFrame(JSON.stringify(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('client.event');
    if (result.frame.type !== 'client.event') return;
    expect(result.frame.event.id).toBe('evt_1');
    expect(result.frame.event.seq).toBe(1);
  });

  it('parses a valid client.command_poll frame with optional fields omitted', () => {
    const poll = { type: 'client.command_poll', clientId: 'cli_1', projectId: 'p_1' };
    const result = parseHqFrame(JSON.stringify(poll));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('client.command_poll');
    if (result.frame.type !== 'client.command_poll') return;
    expect(result.frame.clientId).toBe('cli_1');
    expect(result.frame.projectId).toBe('p_1');
  });

  it('parses a valid client.command_ack frame including the status enum', () => {
    const ack = {
      type: 'client.command_ack',
      clientId: 'cli_1',
      projectId: 'p_1',
      commandId: 'cmd_1',
      status: 'completed',
    };
    const result = parseHqFrame(JSON.stringify(ack));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('client.command_ack');
    if (result.frame.type !== 'client.command_ack') return;
    expect(result.frame.status).toBe('completed');
    expect(result.frame.commandId).toBe('cmd_1');
  });

  it('accepts a Buffer input in addition to a string', () => {
    const result = parseHqFrame(Buffer.from(JSON.stringify(validHello), 'utf8'));
    expect(result.ok).toBe(true);
  });

  it('returns invalid-json for non-JSON payloads', () => {
    const result = parseHqFrame('{not json');
    expect(result).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('returns unknown-type for top-level frames whose type is not in the client union', () => {
    const result = parseHqFrame(JSON.stringify({ type: 'hq.snapshot', snapshot: {} }));
    expect(result).toEqual({ ok: false, reason: 'unknown-type' });
  });

  it('returns malformed for a top-level non-object payload', () => {
    const result = parseHqFrame(JSON.stringify('hello'));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for an object without a string type', () => {
    const result = parseHqFrame(JSON.stringify({ type: 42 }));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a client.hello missing required client identity', () => {
    const bad = {
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: { clientId: 'cli_1' }, // missing kind, machineId, startedAt
        project: validHello.payload.project,
        capabilities: [],
      },
    };
    const result = parseHqFrame(JSON.stringify(bad));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a client.event whose event envelope is missing seq', () => {
    const bad = {
      type: 'client.event',
      event: {
        id: 'evt_1',
        type: 'mailbox.snapshot',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: '2026-06-21T00:00:00.000Z',
        clientId: 'cli_1',
        projectId: 'p_1',
        // seq missing
        payload: {},
      },
    };
    const result = parseHqFrame(JSON.stringify(bad));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a client.command_poll missing clientId', () => {
    const result = parseHqFrame(JSON.stringify({ type: 'client.command_poll', projectId: 'p_1' }));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a client.command_ack missing status', () => {
    const bad = {
      type: 'client.command_ack',
      clientId: 'cli_1',
      projectId: 'p_1',
      commandId: 'cmd_1',
    };
    const result = parseHqFrame(JSON.stringify(bad));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('parseHqEventPayload', () => {
  const validMailboxSnapshot = {
    mailboxId: 'p_1:mailbox',
    scope: 'project' as const,
    messages: [
      {
        mailId: 'm_1',
        messageId: 'm_1',
        from: 'agent-a',
        to: 'agent-b',
        subject: 'Need review',
        priority: 'normal',
        timestamp: '2026-06-21T00:00:00.000Z',
        completed: false,
        hasBody: true,
      },
    ],
    agents: [
      {
        agentId: 'agent-a',
        name: 'Agent A',
        sessionId: 's_1',
        status: 'online',
        iterations: 1,
        toolCalls: 0,
        lastActivityAt: '2026-06-21T00:00:00.000Z',
        lastSeenAt: '2026-06-21T00:00:00.000Z',
        online: true,
      },
    ],
    totals: { messages: 1, unread: 1, incomplete: 0, highPriority: 0, onlineAgents: 1 },
  };

  it('accepts a well-formed mailbox.snapshot payload', () => {
    const result = parseHqEventPayload('mailbox.snapshot', validMailboxSnapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(validMailboxSnapshot);
    }
  });

  it('rejects a mailbox.snapshot payload missing mailboxId', () => {
    const { mailboxId: _unused, ...rest } = validMailboxSnapshot;
    void _unused;
    const result = parseHqEventPayload('mailbox.snapshot', rest);
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('rejects a mailbox.snapshot payload with a wrong scope literal', () => {
    const result = parseHqEventPayload('mailbox.snapshot', {
      ...validMailboxSnapshot,
      scope: 'regional',
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('rejects a mailbox.snapshot payload whose totals is missing a field', () => {
    const result = parseHqEventPayload('mailbox.snapshot', {
      ...validMailboxSnapshot,
      totals: { messages: 1, unread: 1, incomplete: 0, highPriority: 0 }, // no onlineAgents
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('rejects a mailbox.snapshot payload whose message summary is missing hasBody', () => {
    const { hasBody: _dropped, ...messageWithoutHasBody } = validMailboxSnapshot.messages[0];
    void _dropped;
    const result = parseHqEventPayload('mailbox.snapshot', {
      ...validMailboxSnapshot,
      messages: [messageWithoutHasBody],
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('accepts a mailbox.event payload with a known action', () => {
    const result = parseHqEventPayload('mailbox.event', {
      mailboxId: 'p_1:mailbox',
      action: 'message.sent',
      summary: 'agent-a → agent-b: review',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a mailbox.event payload with an unknown action', () => {
    const result = parseHqEventPayload('mailbox.event', {
      mailboxId: 'p_1:mailbox',
      action: 'message.exploded',
      summary: 'oops',
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('rejects a mailbox.event payload whose optional message is malformed', () => {
    const result = parseHqEventPayload('mailbox.event', {
      mailboxId: 'p_1:mailbox',
      action: 'message.sent',
      message: { from: 'agent-a' }, // missing required fields
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('passes through unvalidated event types as unknown', () => {
    const result = parseHqEventPayload('session.started', { sessionId: 's_1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({ sessionId: 's_1' });
    }
  });
});
