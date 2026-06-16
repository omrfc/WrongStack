import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultMailbox } from '../../src/coordination/mailbox.js';

let dir: string;
let mb: DefaultMailbox;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'default-mailbox-'));
  mb = new DefaultMailbox(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const send = (over: Record<string, unknown> = {}) =>
  mb.send({ from: 'a', to: 'b', type: 'info', subject: 's', body: 'hi', ...over } as never);

describe('DefaultMailbox basics', () => {
  it('exposes the mailbox file path', () => {
    expect(mb.mailboxPath).toBe(path.join(dir, '_mailbox.jsonl'));
  });

  it('sends, normalizing the broadcast recipient', async () => {
    const msg = await send({ to: 'all' });
    expect(msg.to).toBe('*');
    expect(msg.priority).toBe('normal');
  });

  it('applies every query filter', async () => {
    await send({ from: 'x', to: 'y', type: 'task', priority: 'high', subject: 'one' });
    await send({ from: 'z', to: 'y', type: 'info', priority: 'low', subject: 'two' });
    await send({ to: '*', subject: 'broadcast' });
    expect((await mb.query({ from: 'x' })).map((m) => m.subject)).toEqual(['one']);
    expect((await mb.query({ type: 'task' })).length).toBe(1);
    expect((await mb.query({ minPriority: 'high' })).length).toBe(1);
    expect((await mb.query({ incompleteOnly: true })).length).toBe(3);
    expect((await mb.query({ to: 'y' })).length).toBe(3); // 2 direct + broadcast
    expect((await mb.query({ limit: 1 })).length).toBe(1);
  });

  it('filters by unreadBy and since', async () => {
    const m1 = await send({ subject: 'first' });
    await send({ subject: 'second' });
    await mb.ack({ messageId: m1.id, readerId: 'b' } as never);
    expect((await mb.query({ unreadBy: 'b' })).map((m) => m.subject)).not.toContain('first');
    expect((await mb.query({ since: '1970-01-01T00:00:00Z' })).length).toBe(2);
  });

  it('acks read/complete/outcome and returns null for unknown ids', async () => {
    const msg = await send({ to: 'b' });
    const acked = await mb.ack({ messageId: msg.id, readerId: 'b', completed: true, outcome: 'ok' } as never);
    expect(acked).toMatchObject({ completed: true, completedBy: 'b', outcome: 'ok' });
    expect(await mb.ack({ messageId: 'nope', readerId: 'b' } as never)).toBeNull();
  });

  it('ack with read:false skips the receipt', async () => {
    const msg = await send({ to: 'b' });
    const acked = await mb.ack({ messageId: msg.id, readerId: 'b', read: false } as never);
    expect(acked?.readBy?.b).toBeUndefined();
  });

  it('counts unread messages for an agent or broadcast', async () => {
    await send({ to: 'b' });
    await send({ to: '*' });
    await send({ to: 'other' });
    expect(await mb.unreadCount('b')).toBe(2);
  });
});

describe('DefaultMailbox agent statuses (from status messages)', () => {
  it('synthesizes the latest status per agent', async () => {
    await send({ from: 'ag1', type: 'status', subject: 'task-a', taskContext: { agentName: 'Neo', agentRole: 'executor', status: 'busy' } });
    // older status for the same agent should be superseded
    await send({ from: 'ag1', type: 'status', subject: 'task-b', taskContext: { status: 'idle' } });
    await send({ from: 'ag2', type: 'status', subject: 'other' });
    await send({ from: 'ag1', type: 'info', subject: 'not-a-status' }); // ignored (not status type)
    const statuses = await mb.getAgentStatuses();
    const ag1 = statuses.find((s) => s.agentId === 'ag1');
    expect(ag1?.currentTask).toBe('task-b'); // newest status wins
    expect(statuses.map((s) => s.agentId).sort()).toEqual(['ag1', 'ag2']);
    expect((await mb.getOnlineAgents()).length).toBe(2);
  });

  it('falls back to from/idle when taskContext is absent', async () => {
    await send({ from: 'bare', type: 'status', subject: 'doing' });
    const s = (await mb.getAgentStatuses())[0];
    expect(s).toMatchObject({ agentId: 'bare', name: 'bare', status: 'idle' });
  });

  it('keeps the newest status when an older one appears later in the file', async () => {
    // Write a NEWER status first, then an OLDER one → the older is skipped.
    const newer = { id: '1', from: 'ag', to: '*', type: 'status', subject: 'newer', body: '', priority: 'normal', readBy: {}, completed: false, timestamp: '2026-02-02T00:00:00Z' };
    const older = { id: '2', from: 'ag', to: '*', type: 'status', subject: 'older', body: '', priority: 'normal', readBy: {}, completed: false, timestamp: '2026-01-01T00:00:00Z' };
    await fs.writeFile(mb.mailboxPath, `${JSON.stringify(newer)}\n${JSON.stringify(older)}\n`);
    const s = (await mb.getAgentStatuses())[0];
    expect(s?.currentTask).toBe('newer'); // older skipped
  });
});

describe('DefaultMailbox query/migration edge cases', () => {
  it('treats an unrecognized priority as normal for minPriority', async () => {
    await send({ priority: 'weird' as never, subject: 'odd' });
    // weird priority → order lookup falls back to 1 (normal) → passes minPriority:'normal'
    expect((await mb.query({ minPriority: 'normal' })).some((m) => m.subject === 'odd')).toBe(true);
  });

  it('uses "unknown" as the read key when a legacy message has no recipient', async () => {
    const legacy = JSON.stringify({ id: '1', from: 'a', type: 'info', subject: 's', body: 'x', read: true, readAt: '2026-01-01T00:00:00Z', timestamp: '2026-01-01T00:00:00Z', priority: 'normal', completed: false });
    await fs.writeFile(mb.mailboxPath, `${legacy}\n`);
    const all = await mb.query({});
    expect(all[0]?.readBy?.unknown).toBe('2026-01-01T00:00:00Z');
  });
});

describe('DefaultMailbox lifecycle + stubs', () => {
  it('close, registerAgent, heartbeat, registerClient, clientHeartbeat are no-ops', async () => {
    await expect(mb.close()).resolves.toBeUndefined();
    await expect(mb.registerAgent({ agentId: 'a', sessionId: 's', name: 'n', role: 'r' } as never)).resolves.toBeUndefined();
    await expect(mb.heartbeat({ agentId: 'a' } as never)).resolves.toBeUndefined();
    await expect(mb.registerClient({ clientId: 'c', sessionId: 's', name: 'n', source: 'tui' } as never)).resolves.toBeUndefined();
    await expect(mb.clientHeartbeat({ clientId: 'c' } as never)).resolves.toBeUndefined();
    expect(await mb.getClientStatuses()).toEqual([]);
  });

  it('clearAll truncates the mailbox', async () => {
    await send();
    await mb.clearAll();
    expect(await mb.query({})).toEqual([]);
  });

  it('purgeStale drops old completed and incomplete messages', async () => {
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const lines = [
      { id: '1', from: 'a', to: 'b', type: 'info', subject: 'old-done', body: '', priority: 'normal', readBy: {}, completed: true, completedAt: oldTs, timestamp: oldTs },
      { id: '2', from: 'a', to: 'b', type: 'info', subject: 'old-incomplete', body: '', priority: 'normal', readBy: {}, completed: false, timestamp: oldTs },
      { id: '3', from: 'a', to: 'b', type: 'info', subject: 'recent', body: '', priority: 'normal', readBy: {}, completed: false, timestamp: new Date().toISOString() },
    ].map((m) => JSON.stringify(m)).join('\n');
    await fs.writeFile(mb.mailboxPath, `${lines}\n`);
    const r = await mb.purgeStale();
    expect(r).toMatchObject({ completedPurged: 1, incompletePurged: 1, totalPurged: 2, remaining: 1 });
  });

  it('purgeStale on an empty mailbox is a no-op', async () => {
    expect((await mb.purgeStale()).totalPurged).toBe(0);
  });
});

describe('DefaultMailbox _readAll', () => {
  it('migrates legacy read/readAt and skips malformed lines', async () => {
    const legacy = JSON.stringify({ id: '1', from: 'a', to: 'b', type: 'info', subject: 's', body: 'x', read: true, readAt: '2026-01-01T00:00:00Z', timestamp: '2026-01-01T00:00:00Z', priority: 'normal', completed: false });
    await fs.writeFile(mb.mailboxPath, `${legacy}\nnot-json\n`);
    const all = await mb.query({});
    expect(all.length).toBe(1);
    expect(all[0]?.readBy?.b).toBe('2026-01-01T00:00:00Z');
  });

  it('returns [] when the mailbox file is absent', async () => {
    expect(await mb.query({})).toEqual([]);
  });

  it('rethrows a non-ENOENT read error (path is a directory)', async () => {
    await fs.mkdir(mb.mailboxPath, { recursive: true });
    await expect(mb.query({})).rejects.toThrow();
  });
});
