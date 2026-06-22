import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GlobalMailbox } from '../../src/coordination/global-mailbox.js';
import type { HqPublisher } from '../../src/hq/publisher.js';

let dir: string;
let mailbox: GlobalMailbox;
const publishEvent = vi.fn();
const publishSnapshot = vi.fn().mockResolvedValue(undefined);

function makePublisher(): HqPublisher {
  return {
    publishEvent,
    publishMailboxEvent: publishEvent,
    publishMailboxSnapshot: publishSnapshot,
  } as never as HqPublisher;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-mailbox-wiring-'));
  publishEvent.mockClear();
  publishSnapshot.mockClear();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('GlobalMailbox HQ publisher wiring', () => {
  it('behaves normally when no HQ publisher is configured', async () => {
    mailbox = new GlobalMailbox(dir);
    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    expect(msg.id).toBeDefined();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(publishSnapshot).not.toHaveBeenCalled();
  });

  it('publishes mailbox.snapshot and mailbox.event on send/register/ack/heartbeat/client activity', async () => {
    mailbox = new GlobalMailbox(dir, undefined, makePublisher());

    await mailbox.registerAgent({ agentId: 'leader@1', sessionId: 'session_1', name: 'Leader', role: 'leader', pid: 1, source: 'cli' });
    const msg = await mailbox.send({ from: 'leader@1', to: '*', type: 'status', subject: 'done', body: 'done' });
    await mailbox.heartbeat({ agentId: 'leader@1', status: 'running' });
    await mailbox.registerClient({ clientId: 'tui@1', sessionId: 'session_1', name: 'TUI', source: 'tui', pid: 1 });
    await mailbox.clientHeartbeat({ clientId: 'tui@1' });
    await mailbox.ack({ messageId: msg.id, readerId: 'leader@1', completed: true, outcome: 'shipped' });

    const actions = publishEvent.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(actions).toContain('agent.registered');
    expect(actions).toContain('message.sent');
    expect(actions).toContain('agent.heartbeat');
    expect(actions).toContain('message.completed');

    expect(publishSnapshot.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps mailbox behavior unaffected when the HQ publisher throws', async () => {
    const failingPublisher = {
      publishMailboxEvent: vi.fn(() => {
        throw new Error('HQ down');
      }),
      publishMailboxSnapshot: vi.fn(() => Promise.reject(new Error('HQ snapshot down'))),
    } as never as HqPublisher;

    mailbox = new GlobalMailbox(dir, undefined, failingPublisher);

    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    expect(msg.id).toBeDefined();
    await expect(mailbox.ack({ messageId: msg.id, readerId: 'b', completed: true })).resolves.toMatchObject({ id: msg.id });
  });
});
