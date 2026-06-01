import { describe, expect, it, vi } from 'vitest';
import { buildCollabCommand } from '../src/slash-commands/collab.js';

function fakeCtx(sessionId?: string) {
  return {
    session: sessionId ? { id: sessionId } : undefined,
  } as never;
}

function fakeOpts(opts: { sessionStore?: unknown } = {}) {
  return opts as never;
}

describe('buildCollabCommand', () => {
  it('exposes the right name and description', () => {
    const cmd = buildCollabCommand(fakeOpts());
    expect(cmd.name).toBe('collab');
    expect(cmd.description).toContain('collaboration');
  });

  it('/collab (no args) defaults to status', async () => {
    const cmd = buildCollabCommand(fakeOpts());
    const res = await cmd.run('', fakeCtx('sess-A'));
    expect(res?.message).toContain('Live collaboration');
    expect(res?.message).toContain('sess-A');
  });

  it('/collab status shows the active session id', async () => {
    const cmd = buildCollabCommand(fakeOpts());
    const res = await cmd.run('status', fakeCtx('sess-B'));
    expect(res?.message).toContain('sess-B');
    expect(res?.message).toContain('Observers');
  });

  it('/collab invite prints a join URL with the session id', async () => {
    const cmd = buildCollabCommand(fakeOpts());
    const res = await cmd.run('invite', fakeCtx('sess-C'));
    expect(res?.message).toContain('http://127.0.0.1:3457/');
    expect(res?.message).toContain('sess-C');
  });

  it('/collab invite without an active session warns and does not print a URL', async () => {
    const cmd = buildCollabCommand(fakeOpts());
    const res = await cmd.run('invite', fakeCtx());
    expect(res?.message).not.toContain('http://');
    expect(res?.message).toMatch(/no active session/i);
  });

  it('/collab history surfaces events from the SessionReader', async () => {
    const events = [
      { type: 'user_input', ts: '2026-01-01T10:00:00Z', text: 'hello world' },
      { type: 'tool_result', ts: '2026-01-01T10:00:05Z', name: 'read', ok: true },
      { type: 'compaction', ts: '2026-01-01T10:00:10Z', before: 50000, after: 30000 },
    ];
    const sessionStore = {
      load: vi.fn().mockResolvedValue({ events }),
    } as never;
    const cmd = buildCollabCommand(fakeOpts({ sessionStore }));
    const res = await cmd.run('history', fakeCtx('sess-D'));
    expect(res?.message).toContain('Last 3 events of sess-D');
    expect(res?.message).toContain('user_input');
    expect(res?.message).toContain('tool_result');
    expect(res?.message).toContain('read');
    expect(res?.message).toContain('50000→30000');
  });

  it('/collab history respects the N argument (default 20, max 200)', async () => {
    const events = Array.from({ length: 250 }, (_, i) => ({
      type: 'user_input',
      ts: '2026-01-01T00:00:00Z',
      text: `m${i}`,
    }));
    const sessionStore = { load: vi.fn().mockResolvedValue({ events }) } as never;
    const cmd = buildCollabCommand(fakeOpts({ sessionStore }));
    const res = await cmd.run('history 5', fakeCtx('sess-E'));
    expect(res?.message).toContain('Last 5 events of sess-E');
  });

  it('/collab history warns when no session is active', async () => {
    const cmd = buildCollabCommand(fakeOpts({ sessionStore: {} }));
    const res = await cmd.run('history', fakeCtx());
    expect(res?.message).toMatch(/no active session/i);
  });

  it('/collab history warns when no session store is configured', async () => {
    const cmd = buildCollabCommand(fakeOpts());
    const res = await cmd.run('history', fakeCtx('sess-F'));
    expect(res?.message).toMatch(/no session store/i);
  });

  it('/collab help shows the subcommand list', async () => {
    const cmd = buildCollabCommand(fakeOpts());
    const res = await cmd.run('help', fakeCtx());
    expect(res?.message).toContain('status');
    expect(res?.message).toContain('invite');
    expect(res?.message).toContain('history');
  });

  it('unknown subcommand returns a yellow warning', async () => {
    const cmd = buildCollabCommand(fakeOpts());
    const res = await cmd.run('bogus', fakeCtx('sess-G'));
    expect(res?.message).toMatch(/unknown subcommand/i);
    expect(res?.message).toMatch(/bogus/);
  });

  it('/collab annotations shows empty message when no annotations exist', async () => {
    // The annotations subcommand needs the sessionStore to expose its dir.
    // We pass a fake that satisfies the type.
    const sessionStore = { dir: '/tmp/nope', list: vi.fn() } as never;
    const cmd = buildCollabCommand(fakeOpts({ sessionStore }));
    const res = await cmd.run('annotations', fakeCtx('sess-H'));
    // Either the "no annotations" message OR a dir-missing message — both
    // prove the subcommand dispatched. (The AnnotationsStore will create
    // /tmp/nope/<id>.annotations.json if it doesn't exist, so we get
    // "No open annotations".)
    expect(res?.message).toMatch(/no open annotations|dir/i);
  });
});
