import { describe, expect, it, vi } from 'vitest';
import type { MailboxAgentStatus, MailboxMessage } from '../../src/coordination/mailbox-types.js';
import { HqPublisher, type HqSocketLike } from '../../src/hq/publisher.js';

class FakeSocket implements HqSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const client = {
  clientId: 'client_1',
  kind: 'cli' as const,
  machineId: 'machine_1',
  startedAt: '2026-06-21T12:00:00.000Z',
};

const project = {
  projectId: 'project_1',
  projectRoot: '/repo',
  projectName: 'repo',
  machineId: 'machine_1',
  workspaceKind: 'git' as const,
};

const message: MailboxMessage = {
  id: 'msg_1',
  from: 'leader@a',
  to: '*',
  type: 'status',
  subject: 'Done',
  body: 'SECRET_TOKEN=abcdefghijklmnopqrstuvwxyz123456',
  priority: 'normal',
  readBy: {},
  completed: false,
  timestamp: '2026-06-21T12:00:00.000Z',
};

const agent: MailboxAgentStatus = {
  agentId: 'leader@a',
  name: 'Leader',
  sessionId: 'session_1',
  status: 'running',
  iterations: 1,
  toolCalls: 2,
  lastActivityAt: '2026-06-21T12:00:00.000Z',
  lastSeenAt: '2026-06-21T12:00:00.000Z',
  online: true,
  pid: 123,
  source: 'cli',
};

function parseSent(socket: FakeSocket): unknown[] {
  return socket.sent.map((frame) => JSON.parse(frame) as unknown);
}

describe('HqPublisher', () => {
  it('connects to /ws/client and sends hello plus queued mailbox events', () => {
    const sockets: FakeSocket[] = [];
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      token: 'token_1',
      client,
      project,
      now: () => '2026-06-21T12:00:00.000Z',
      idFactory: () => 'evt_1',
      socketFactory: (url) => {
        expect(url).toBe('ws://localhost:3499/ws/client?token=token_1');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const event = publisher.publishMailboxEvent({ mailboxId: 'project_1:mailbox', action: 'message.sent', message });
    expect(event.type).toBe('mailbox.event');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toEqual([]);

    sockets[0]?.open();
    const frames = parseSent(sockets[0]!);
    expect(frames).toMatchObject([
      { type: 'client.hello' },
      { type: 'client.event', event: { type: 'mailbox.event', payload: { action: 'message.sent' } } },
    ]);
    expect(JSON.stringify(frames)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('publishes mailbox snapshots from the mailbox API', async () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      now: () => '2026-06-21T12:00:00.000Z',
      idFactory: () => 'evt_snapshot',
      socketFactory: () => socket,
    });

    publisher.connect();
    await publisher.publishMailboxSnapshot(
      {
        query: async () => [message],
        getAgentStatuses: async () => [agent],
      },
      { mailboxId: 'project_1:mailbox', sessionId: 'session_1' },
    );

    const frames = parseSent(socket);
    expect(frames).toMatchObject([
      { type: 'client.hello' },
      {
        type: 'client.event',
        event: {
          id: 'evt_snapshot',
          type: 'mailbox.snapshot',
          sessionId: 'session_1',
          payload: { totals: { messages: 1, incomplete: 1, onlineAgents: 1 } },
        },
      },
    ]);
  });

  it('polls commands over the outbound client connection and acknowledges handled commands', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const handled: string[] = [];
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      commandPollIntervalMs: 1_000,
      onCommand: (command) => {
        handled.push(command.commandId);
        return { commandId: command.commandId, status: 'completed', message: 'ok' };
      },
      socketFactory: () => socket,
    });

    publisher.connect();
    socket.open();

    expect(parseSent(socket)).toContainEqual({
      type: 'client.command_poll',
      clientId: 'client_1',
      projectId: 'project_1',
      limit: 25,
    });

    socket.message(JSON.stringify({
      type: 'hq.command_batch',
      commands: [{ commandId: 'cmd_1', type: 'refresh', createdAt: '2026-06-21T12:00:00.000Z', payload: {} }],
    }));
    await Promise.resolve();

    expect(handled).toEqual(['cmd_1']);
    expect(parseSent(socket)).toContainEqual({
      type: 'client.command_ack',
      clientId: 'client_1',
      projectId: 'project_1',
      commandId: 'cmd_1',
      status: 'completed',
      message: 'ok',
    });

    publisher.pollCommands();
    expect(parseSent(socket)).toContainEqual({
      type: 'client.command_poll',
      clientId: 'client_1',
      projectId: 'project_1',
      afterCommandId: 'cmd_1',
      limit: 25,
    });
    publisher.close();
    vi.useRealTimers();
  });
});
