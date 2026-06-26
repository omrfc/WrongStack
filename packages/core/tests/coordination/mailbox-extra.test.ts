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

  it('ackMany sets cache metadata synchronously (no zombie stat race)', async () => {
    // Regression: the previous _setMessageCache() did a fire-and-forget
    // fsp.stat() when called without mtime/size. ackMany, clearAll, and
    // purgeStale all used that path. After the rewrite released the file
    // lock, the cache metadata was at the sentinel (-1, -1) or stale
    // values from before the rewrite. A subsequent _readAllCached() call
    // could take the "file only grew" branch against those stale values
    // and append the rewritten file's contents onto the still-cached
    // old messages, producing duplicates.
    //
    // After the fix, the cache metadata is set synchronously under the
    // same lock that produced it. A query immediately after ackMany (no
    // intervening send/append) must return the post-ack state without
    // any duplication or loss.
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await send({ subject: `m${i}` });
      sent.push(m.id);
    }
    // ackMany rewrites the file under the lock. Previously the cache
    // metadata was set asynchronously after the lock released, so a
    // query landing in the gap could see a racy intermediate state.
    await mb.ackMany({ acks: [{ messageId: sent[0]!, readerId: 'b' }] });
    const all = await mb.query({ limit: 100 });
    // No sends happened after ackMany, so the cache and the file must
    // be in lock-step: 5 messages, no duplicates.
    expect(all.length).toBe(5);
    const ids = new Set(all.map((m) => m.id));
    expect(ids.size).toBe(5);
    for (const id of sent) expect(ids.has(id)).toBe(true);
    // The first message must reflect the ack we issued.
    const acked = all.find((m) => m.id === sent[0]);
    expect(acked?.readBy?.b).toBeTruthy();
  });

  it('clearAll sets cache metadata synchronously (no zombie stat)', async () => {
    // Same regression shape: clearAll rewrites the file to empty under
    // the lock, and previously did not pass mtime/size to the cache
    // helper. A query right after clearAll must return [] (no race).
    await send({ subject: 'will-be-cleared' });
    await send({ subject: 'will-be-cleared' });
    await mb.clearAll();
    const all = await mb.query({ limit: 100 });
    expect(all).toEqual([]);
  });

  it('purgeStale sets cache metadata synchronously (no zombie stat)', async () => {
    // purgeStale rewrites the file under the lock when it drops
    // messages. Previously did not pass mtime/size to the cache
    // helper. A query right after purgeStale must return only the
    // post-purge state, with no race-induced extra messages.
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const stale = {
      id: 'stale-1', from: 'a', to: 'b', type: 'info',
      subject: 'stale', body: '', priority: 'normal', readBy: {},
      completed: false, timestamp: oldTs,
    };
    const recent = {
      id: 'recent-1', from: 'a', to: 'b', type: 'info',
      subject: 'recent', body: '', priority: 'normal', readBy: {},
      completed: false, timestamp: new Date().toISOString(),
    };
    await fs.writeFile(
      mb.mailboxPath,
      `${[stale, recent].map((m) => JSON.stringify(m)).join('\n')}\n`,
    );
    await mb.purgeStale();
    const all = await mb.query({ limit: 100 });
    const ids = new Set(all.map((m) => m.id));
    expect(ids.has('stale-1')).toBe(false);
    expect(ids.has('recent-1')).toBe(true);
    expect(all.length).toBe(1);
  });

  it('send after a prior read does not duplicate messages (cache size stays in lock-step)', async () => {
    // Regression: send() used to call _pushToCache(msg) but did not
    // advance _messageCacheSize. The next _readAllCached() saw
    // st.size > _messageCacheSize, took the incremental "file only
    // grew" branch, and re-parsed the just-appended bytes — pushing
    // them onto the cache a second time.
    //
    // This is most visible when the cache is already populated (so
    // _messageCacheSize is non-negative) and a send() happens after
    // a read. The fix stats the file under the same lock as the
    // append and updates the cache size/mtime, so the next read
    // hits the fast path and returns exactly the messages on disk.
    const m0 = await send({ subject: 'first' });
    // Force a read so the cache is populated and the file size is
    // known. Before the fix, _messageCacheSize is now S1 (the size
    // after one message) and _messageCacheMtime is M1.
    const firstRead = await mb.query({ limit: 100 });
    expect(firstRead.length).toBe(1);
    // Now send more messages. The pre-fix code would push them to
    // the cache but leave _messageCacheSize at S1.
    for (let i = 0; i < 4; i++) {
      await send({ subject: `extra-${i}` });
    }
    const all = await mb.query({ limit: 100 });
    // Must be exactly 5 messages, not 10.
    expect(all.length).toBe(5);
    const ids = new Set(all.map((m) => m.id));
    expect(ids.size).toBe(5);
    expect(ids.has(m0.id)).toBe(true);
  });

  it('send + ackMany + send + query does not duplicate messages', async () => {
    // Same regression shape, with an ackMany (which rewrites the file)
    // in the middle. Previously the sequence produced 15 messages
    // (5 from the initial sends + 5 re-parsed from the post-ack
    // incremental read + 5 from the post-ack sends + 5 re-parsed
    // again). After the fix, the cache size/mtime advances under
    // the lock on every write, so the incremental path never fires
    // against an already-cached range.
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await send({ subject: `m${i}` });
      sent.push(m.id);
    }
    await mb.ackMany({ acks: [{ messageId: sent[0]!, readerId: 'b' }] });
    for (let i = 5; i < 10; i++) {
      const m = await send({ subject: `m${i}` });
      sent.push(m.id);
    }
    const all = await mb.query({ limit: 100 });
    expect(all.length).toBe(10);
    const ids = new Set(all.map((m) => m.id));
    expect(ids.size).toBe(10);
    for (const id of sent) expect(ids.has(id)).toBe(true);
    // The first message must reflect the ack we issued.
    const acked = all.find((m) => m.id === sent[0]);
    expect(acked?.readBy?.b).toBeTruthy();
  });

  it('send + clearAll + send + query does not duplicate messages', async () => {
    // Same regression shape, with clearAll (which truncates the file
    // to empty) in the middle. The pre-fix code left _messageCacheSize
    // at the pre-clear value, so the post-clear send+query would
    // re-parse the cleared bytes.
    await send({ subject: 'will-be-cleared' });
    await send({ subject: 'will-be-cleared' });
    await mb.clearAll();
    await send({ subject: 'fresh-1' });
    await send({ subject: 'fresh-2' });
    const all = await mb.query({ limit: 100 });
    expect(all.length).toBe(2);
    const subjects = new Set(all.map((m) => m.subject));
    expect(subjects.has('fresh-1')).toBe(true);
    expect(subjects.has('fresh-2')).toBe(true);
    expect(subjects.has('will-be-cleared')).toBe(false);
  });

  it('send + purgeStale + send + query does not duplicate messages', async () => {
    // Same regression shape, with purgeStale in the middle. The pre-fix
    // code left _messageCacheSize at the pre-purge value, so the
    // post-purge send+query would re-parse the purged bytes.
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const stale = {
      id: 'stale-1', from: 'a', to: 'b', type: 'info',
      subject: 'stale', body: '', priority: 'normal', readBy: {},
      completed: false, timestamp: oldTs,
    };
    const recent = {
      id: 'recent-1', from: 'a', to: 'b', type: 'info',
      subject: 'recent', body: '', priority: 'normal', readBy: {},
      completed: false, timestamp: new Date().toISOString(),
    };
    await fs.writeFile(
      mb.mailboxPath,
      `${[stale, recent].map((m) => JSON.stringify(m)).join('\n')}\n`,
    );
    await mb.purgeStale();
    await send({ subject: 'after-purge' });
    const all = await mb.query({ limit: 100 });
    const ids = new Set(all.map((m) => m.id));
    expect(ids.has('stale-1')).toBe(false);
    expect(ids.has('recent-1')).toBe(true);
    expect(ids.size).toBe(2);
    const afterPurge = all.find((m) => m.subject === 'after-purge');
    expect(afterPurge).toBeTruthy();
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
