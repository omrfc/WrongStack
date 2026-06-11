import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DefaultMailbox } from '../../src/coordination/mailbox.js';
import type {
  MailboxMessage,
  MailboxSendInput,
} from '../../src/coordination/mailbox-types.js';
import { makeMailboxTool, mailboxSessionTag } from '../../src/coordination/mailbox-tool.js';
import {
  createMailboxChecker,
  buildMailboxBlock,
} from '../../src/core/mailbox-loop.js';
import {
  makeDependencyWatcherConfig,
  DEPENDENCY_FILE_PATTERNS,
} from '../../src/coordination/dep-watcher.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Minimal mock Context for tool tests — the mailbox tool only reads ctx.meta. */
function mockCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { meta: {}, ...overrides };
}

function tmpDir(): string {
  return path.join(os.tmpdir(), `ws-mailbox-test-${randomUUID().slice(0, 8)}`);
}

async function createMailbox(): Promise<{ mailbox: DefaultMailbox; dir: string }> {
  const dir = tmpDir();
  await fs.mkdir(dir, { recursive: true });
  return { mailbox: new DefaultMailbox(dir), dir };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('DefaultMailbox', () => {
  let mailbox: DefaultMailbox;
  let dir: string;

  beforeEach(async () => {
    const m = await createMailbox();
    mailbox = m.mailbox;
    dir = m.dir;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the mailbox file on first send', async () => {
    const msg = await mailbox.send({
      from: 'agent-a',
      to: 'agent-b',
      type: 'note',
      subject: 'Hello',
      body: 'Test message',
    });
    expect(msg.id).toBeDefined();
    expect(msg.from).toBe('agent-a');
    expect(msg.to).toBe('agent-b');
    // Per-recipient read receipts replaced the old `read: boolean` —
    // a fresh message starts with an empty readBy map.
    expect(msg.readBy).toEqual({});
    expect(msg.completed).toBe(false);

    // Verify file exists
    const exists = await fs.access(mailbox.mailboxPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('query returns messages filtered by recipient', async () => {
    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'to b', body: 'body' });
    await mailbox.send({ from: 'a', to: 'c', type: 'note', subject: 'to c', body: 'body' });
    await mailbox.send({ from: 'a', to: '*', type: 'broadcast', subject: 'all', body: 'body' });

    const forB = await mailbox.query({ to: 'b' });
    expect(forB.length).toBe(2); // 'to b' + broadcast
    expect(forB[0]!.subject).toBe('all'); // newest first
    expect(forB[1]!.subject).toBe('to b');

    const forC = await mailbox.query({ to: 'c' });
    expect(forC.length).toBe(2); // 'to c' + broadcast
  });

  it('query filters unread messages', async () => {
    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 's1', body: 'b1' });
    // Small delay so timestamps differ — query sorts newest-first
    await new Promise((r) => setTimeout(r, 5));
    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 's2', body: 'b2' });

    const all = await mailbox.query({ to: 'b' });
    expect(all.length).toBe(2);

    // Mark the newest (subject 's2') as read
    await mailbox.ack({ messageId: all[0]!.id, readerId: 'b', read: true });

    const unread = await mailbox.query({ to: 'b', unreadBy: 'b' });
    expect(unread.length).toBe(1);
    expect(unread[0]!.subject).toBe('s1');
  });

  it('query filters by message type', async () => {
    await mailbox.send({ from: 'a', to: 'b', type: 'steer', subject: 'steer', body: 'b' });
    await mailbox.send({ from: 'a', to: 'b', type: 'btw', subject: 'btw', body: 'b' });
    await mailbox.send({ from: 'a', to: 'b', type: 'ask', subject: 'ask', body: 'b' });

    const steers = await mailbox.query({ to: 'b', type: 'steer' });
    expect(steers.length).toBe(1);
    expect(steers[0]!.type).toBe('steer');
  });

  it('query filters by minPriority', async () => {
    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'low', body: 'b', priority: 'low' });
    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'normal', body: 'b', priority: 'normal' });
    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'high', body: 'b', priority: 'high' });

    const highOnly = await mailbox.query({ to: 'b', minPriority: 'high' });
    expect(highOnly.length).toBe(1);
    expect(highOnly[0]!.subject).toBe('high');

    const normalAndUp = await mailbox.query({ to: 'b', minPriority: 'normal' });
    expect(normalAndUp.length).toBe(2);
  });

  it('query limits results', async () => {
    for (let i = 0; i < 10; i++) {
      await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: `s${i}`, body: 'b' });
    }

    const limited = await mailbox.query({ to: 'b', limit: 3 });
    expect(limited.length).toBe(3);
  });

  it('query sorts newest first', async () => {
    const m1 = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'older', body: 'b' });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'newer', body: 'b' });

    const results = await mailbox.query({ to: 'b' });
    expect(results[0]!.subject).toBe('newer');
    expect(results[1]!.subject).toBe('older');
  });

  it('ack marks message as read', async () => {
    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'test', body: 'b' });

    const updated = await mailbox.ack({ messageId: msg.id, readerId: 'b', read: true });
    expect(updated).not.toBeNull();
    expect(updated!.readBy['b']).toBeDefined();

    // Re-query and verify persistence
    const results = await mailbox.query({ to: 'b', unreadBy: 'b' });
    expect(results.length).toBe(0);
  });

  it('ack marks message as completed with outcome', async () => {
    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'assign', subject: 'task', body: 'do this' });

    const updated = await mailbox.ack({
      messageId: msg.id,
      readerId: 'b',
      completed: true,
      outcome: 'Done — validated all packages',
    });
    expect(updated).not.toBeNull();
    expect(updated!.completed).toBe(true);
    expect(updated!.outcome).toBe('Done — validated all packages');

    // incompleteOnly should filter it out
    const incomplete = await mailbox.query({ to: 'b', incompleteOnly: true });
    expect(incomplete.length).toBe(0);
  });

  it('ack returns null for unknown message id', async () => {
    const result = await mailbox.ack({ messageId: 'nonexistent', readerId: 'b', read: true });
    expect(result).toBeNull();
  });

  it('send accepts full MailboxSendInput fields', async () => {
    const msg = await mailbox.send({
      from: 'watcher',
      to: 'tech-stack-agent',
      type: 'assign',
      subject: 'Audit dependencies',
      body: 'package.json changed',
      priority: 'high',
      replyTo: 'prev-msg-id',
      taskContext: {
        agentRole: 'tech-stack',
        status: 'pending',
      },
    });
    expect(msg.id).toBeDefined();
    expect(msg.replyTo).toBe('prev-msg-id');
    expect(msg.taskContext?.agentRole).toBe('tech-stack');
  });

  it('getAgentStatuses returns agents that posted status messages', async () => {
    await mailbox.send({
      from: 'agent-1',
      to: '*',
      type: 'status',
      subject: 'Auditing dependencies',
      body: 'Working on tech-stack audit',
      taskContext: { agentName: 'Tesla (Executor)', status: 'running' },
    });
    await mailbox.send({
      from: 'agent-2',
      to: '*',
      type: 'status',
      subject: 'Scanning for bugs',
      body: 'Bug hunt in progress',
      taskContext: { agentName: 'Einstein (BugHunter)', status: 'running' },
    });

    const statuses = await mailbox.getAgentStatuses();
    expect(statuses.length).toBe(2);

    const tesla = statuses.find((s) => s.name === 'Tesla (Executor)');
    expect(tesla).toBeDefined();
    expect(tesla!.status).toBe('running');
    expect(tesla!.currentTask).toBe('Auditing dependencies');
  });

  it('getAgentStatuses only returns latest status per agent', async () => {
    await mailbox.send({
      from: 'agent-1', to: '*', type: 'status', subject: 'Starting...',
      body: '', taskContext: { agentName: 'Agent 1', status: 'running' },
    });
    // Small delay
    await new Promise((r) => setTimeout(r, 5));
    await mailbox.send({
      from: 'agent-1', to: '*', type: 'status', subject: 'Done!',
      body: '', taskContext: { agentName: 'Agent 1', status: 'idle' },
    });

    const statuses = await mailbox.getAgentStatuses();
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.status).toBe('idle');
    expect(statuses[0]!.currentTask).toBe('Done!');
  });

  it('is resilient to missing file on first query', async () => {
    const results = await mailbox.query({ to: 'nobody' });
    expect(results).toEqual([]);
  });

  it('persists and reloads messages across instances', async () => {
    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'persistent', body: 'body' });

    // Create a new mailbox instance pointing to the same directory
    const mailbox2 = new DefaultMailbox(dir);
    const results = await mailbox2.query({ to: 'b' });
    expect(results.length).toBe(1);
    expect(results[0]!.subject).toBe('persistent');
  });
});

// ── Mailbox Tool ─────────────────────────────────────────────────────────

describe('makeMailboxTool', () => {
  let mailbox: DefaultMailbox;
  let dir: string;
  /** Tool pre-wired to the test mailbox — created in beforeEach. */
  let toolForAgentB: ReturnType<typeof makeMailboxTool>;
  let toolForAgentX: ReturnType<typeof makeMailboxTool>;
  let toolForSender: ReturnType<typeof makeMailboxTool>;
  let toolForBroadcaster: ReturnType<typeof makeMailboxTool>;
  let toolForDirector: ReturnType<typeof makeMailboxTool>;

  beforeEach(async () => {
    const m = await createMailbox();
    mailbox = m.mailbox;
    dir = m.dir;
    // Create tools AFTER mailbox is available
    toolForAgentB = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'agent-b' });
    toolForAgentX = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'agent-x' });
    toolForSender = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'sender' });
    toolForBroadcaster = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'broadcaster' });
    toolForDirector = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'director' });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Helper: create a one-off tool for a specific agent id. */
  function makeTestTool(agentId: string) {
    return makeMailboxTool({ resolveMailbox: () => mailbox, agentId });
  }

  it('check returns unread messages', async () => {
    await mailbox.send({ from: 'a', to: 'agent-b', type: 'note', subject: 's1', body: 'b1' });
    await mailbox.send({ from: 'a', to: 'agent-b', type: 'ask', subject: 's2', body: 'b2' });

    // Create tool inline AFTER messages are written — guarantees closure sees the set mailbox
    const tool = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'agent-b' });
    const result = await tool.execute({ action: 'check' }, mockCtx() as any);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    // check auto-acks. Read receipts are recorded under the PROCESS-UNIQUE
    // identity (`agent-b#<pid>`) so multiple processes sharing a base id
    // never consume each other's read state.
    const uniqueId = `agent-b@${mailboxSessionTag('default')}`;
    const remaining = await mailbox.query({ to: 'agent-b', unreadBy: uniqueId });
    expect(remaining.length).toBe(0);
  });

  it('check returns empty when no messages', async () => {
    const result = await toolForAgentX.execute({ action: 'check' }, mockCtx() as any);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.summary).toBe('No unread messages.');
  });

  it('send posts a message', async () => {
    const result = await toolForSender.execute({
      action: 'send',
      to: 'receiver',
      type: 'ask',
      subject: 'Question',
      body: 'Can you help?',
    }, mockCtx() as any);

    expect(result.ok).toBe(true);
    expect(result.messageId).toBeDefined();

    const msgs = await mailbox.query({ to: 'receiver' });
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.subject).toBe('Question');
    // Sends are attributed to the process-unique identity so replies route
    // back to the exact process that asked.
    expect(msgs[0]!.from).toBe(`sender@${mailboxSessionTag('default')}`);
  });

  it('send validates required fields', async () => {
    const r1 = await toolForSender.execute({ action: 'send' }, mockCtx() as any);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('"to" is required');

    const r2 = await toolForSender.execute({ action: 'send', to: 'r' }, mockCtx() as any);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('"type" is required');
  });

  it('send with broadcast goes to all', async () => {
    await toolForBroadcaster.execute({
      action: 'send',
      to: '*',
      type: 'broadcast',
      subject: 'Everyone',
      body: 'Hello all',
    }, mockCtx() as any);

    const forA = await mailbox.query({ to: 'agent-a' });
    expect(forA.length).toBe(1);

    const forB = await mailbox.query({ to: 'agent-b' });
    expect(forB.length).toBe(1);
  });

  it('ack marks message as read and completed', async () => {
    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'assign', subject: 'task', body: 'body' });
    const result = await toolForAgentB.execute({
      action: 'ack',
      messageId: msg.id,
      completed: true,
      outcome: 'Fixed!',
    }, mockCtx() as any);

    expect(result.ok).toBe(true);

    const updated = await mailbox.query({ to: 'b', incompleteOnly: true });
    expect(updated.length).toBe(0);
  });

  it('query filters by sender', async () => {
    await mailbox.send({ from: 'alice', to: 'b', type: 'note', subject: 'from alice', body: 'b' });
    await mailbox.send({ from: 'bob', to: 'b', type: 'note', subject: 'from bob', body: 'b' });
    const result = await toolForAgentB.execute({ action: 'query', from: 'alice' }, mockCtx() as any);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.messages[0].subject).toBe('from alice');
  });

  it('status returns agent statuses', async () => {
    await mailbox.send({
      from: 'worker-1', to: '*', type: 'status', subject: 'Working',
      body: '', taskContext: { agentName: 'Worker 1', status: 'running' },
    });
    const result = await toolForDirector.execute({ action: 'status' }, mockCtx() as any);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.agents[0].name).toBe('Worker 1');
    expect(result.agents[0].status).toBe('running');
  });

  it('unknown action returns error', async () => {
    const result = await makeTestTool('x').execute({ action: 'invalid' }, mockCtx() as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown action');
  });
});

// ── Mailbox Loop ─────────────────────────────────────────────────────────

describe('mailbox-loop', () => {
  let mailbox: DefaultMailbox;
  let dir: string;

  beforeEach(async () => {
    const m = await createMailbox();
    mailbox = m.mailbox;
    dir = m.dir;
  });

  afterEach(async () => {
    // Windows may hold file handles briefly after mailbox writes — retry
    for (let i = 0; i < 3; i++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch {
        if (i === 2) throw new Error(`Failed to clean up ${dir}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  });

  it('createMailboxChecker returns all unread message types', async () => {
    const check = createMailboxChecker({ mailbox, agentId: 'agent-b' });

    await mailbox.send({ from: 'director', to: 'agent-b', type: 'steer', subject: 'Change approach', body: 'Use X instead', priority: 'high' });
    await mailbox.send({ from: 'director', to: 'agent-b', type: 'btw', subject: 'FYI', body: 'Something changed', priority: 'high' });
    await mailbox.send({ from: 'director', to: 'agent-b', type: 'ask', subject: 'Question', body: 'What?', priority: 'normal' });

    const msgs = await check();
    expect(msgs.length).toBe(3); // all types returned now, not just steer/btw
    const types = msgs.map((m) => m.type);
    expect(types).toContain('steer');
    expect(types).toContain('btw');
    expect(types).toContain('ask');
  });

  it('createMailboxChecker receives base-id alias messages and dedupes broadcasts', async () => {
    // Multi-process identity: the checker runs as the unique `leader#123`
    // but must ALSO receive messages addressed to the bare base id and
    // '*' broadcasts — each exactly once.
    const check = createMailboxChecker({
      mailbox,
      agentId: 'leader#123',
      aliases: ['leader'],
    });

    await mailbox.send({ from: 'a', to: 'leader#123', type: 'note', subject: 'direct', body: 'd' });
    await mailbox.send({ from: 'a', to: 'leader', type: 'note', subject: 'alias', body: 'al' });
    await mailbox.send({ from: 'a', to: '*', type: 'broadcast', subject: 'bcast', body: 'b' });
    await mailbox.send({ from: 'a', to: 'someone-else', type: 'note', subject: 'other', body: 'o' });

    const msgs = await check();
    const subjects = msgs.map((m) => m.subject).sort();
    expect(subjects).toEqual(['alias', 'bcast', 'direct']);
    // Read receipts recorded under the UNIQUE id, not the alias. The
    // checker acks fire-and-forget — poll briefly for the receipt to land.
    let receipted = false;
    for (let i = 0; i < 40 && !receipted; i++) {
      const all = await mailbox.query({ limit: 50 });
      const aliasMsg = all.find((m) => m.subject === 'alias');
      receipted = !!aliasMsg && 'leader#123' in aliasMsg.readBy;
      if (!receipted) await new Promise((r) => setTimeout(r, 25));
    }
    expect(receipted).toBe(true);
  });

  it('createMailboxChecker does not return already-injected messages', async () => {
    const check = createMailboxChecker({ mailbox, agentId: 'agent-b' });
    await mailbox.send({ from: 'd', to: 'agent-b', type: 'steer', subject: 's1', body: 'b', priority: 'high' });

    const first = await check();
    expect(first.length).toBe(1);

    const second = await check();
    expect(second.length).toBe(0); // already injected
  });

  it('buildMailboxBlock formats messages correctly', () => {
    const msgs: MailboxMessage[] = [
      {
        id: '1', from: 'director', to: 'agent-b', type: 'steer',
        subject: 'Use tool X', body: 'Switch to tool X for this task.',
        priority: 'high', readBy: {}, completed: false, timestamp: new Date().toISOString(),
      },
    ];

    const block = buildMailboxBlock(msgs);
    expect(block.type).toBe('text');
    expect(block.text).toContain('[MAILBOX]');
    expect(block.text).toContain('STEER');
    expect(block.text).toContain('Use tool X');
    expect(block.text).toContain('[END MAILBOX]');
  });

  it('buildMailboxBlock throws on empty array', () => {
    expect(() => buildMailboxBlock([])).toThrow();
  });
});

// ── Dependency Watcher ───────────────────────────────────────────────────

describe('makeDependencyWatcherConfig', () => {
  let mailbox: DefaultMailbox;
  let dir: string;

  beforeEach(async () => {
    const m = await createMailbox();
    mailbox = m.mailbox;
    dir = m.dir;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('generates watch paths for dependency files', () => {
    const cfg = makeDependencyWatcherConfig({
      projectRoot: '/fake/project',
      mailbox,
    });
    expect(cfg.watchPaths.length).toBeGreaterThan(0);
    // Should include the project root
    expect(cfg.watchPaths).toContain('/fake/project');
    // Should include package.json path
    expect(cfg.watchPaths).toContain('/fake/project/package.json');
  });

  it('onChange posts mailbox message for dependency file', async () => {
    const cfg = makeDependencyWatcherConfig({
      projectRoot: '/fake/project',
      mailbox,
      targetAgent: 'tech-stack',
      debounceMs: 10,
    });

    await cfg.onChange({
      path: '/fake/project/package.json',
      event: 'change',
      timestamp: new Date().toISOString(),
    });

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 50));

    const msgs = await mailbox.query({ to: 'tech-stack' });
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.type).toBe('assign');
    expect(msgs[0]!.subject).toContain('package.json');
    expect(msgs[0]!.taskContext?.agentRole).toBe('tech-stack');
  });

  it('onChange ignores non-dependency files', async () => {
    const cfg = makeDependencyWatcherConfig({
      projectRoot: '/fake/project',
      mailbox,
      debounceMs: 10,
    });

    await cfg.onChange({
      path: '/fake/project/src/index.ts',
      event: 'change',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 50));

    const msgs = await mailbox.query({});
    expect(msgs.length).toBe(0);
  });

  it('onChange ignores delete events', async () => {
    const cfg = makeDependencyWatcherConfig({
      projectRoot: '/fake/project',
      mailbox,
      debounceMs: 10,
    });

    await cfg.onChange({
      path: '/fake/project/package.json',
      event: 'delete',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 50));

    const msgs = await mailbox.query({});
    expect(msgs.length).toBe(0);
  });

  it('debounces rapid changes to same file', async () => {
    const cfg = makeDependencyWatcherConfig({
      projectRoot: '/fake/project',
      mailbox,
      targetAgent: 'tech-stack',
      debounceMs: 20,
    });

    // Rapid-fire 5 changes
    for (let i = 0; i < 5; i++) {
      await cfg.onChange({
        path: '/fake/project/package.json',
        event: 'change',
        timestamp: new Date().toISOString(),
      });
    }

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 60));

    const msgs = await mailbox.query({ to: 'tech-stack' });
    expect(msgs.length).toBe(1); // debounced to one
  });

  it('DEPENDENCY_FILE_PATTERNS covers major ecosystems', () => {
    expect(DEPENDENCY_FILE_PATTERNS).toContain('package.json');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('go.mod');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('Cargo.toml');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('pyproject.toml');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('Gemfile');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('composer.json');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('pubspec.yaml');
  });

  it('matches glob patterns for *.csproj', async () => {
    const cfg = makeDependencyWatcherConfig({
      projectRoot: '/fake/project',
      mailbox,
      debounceMs: 10,
    });

    await cfg.onChange({
      path: '/fake/project/MyProject.csproj',
      event: 'change',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 50));

    const msgs = await mailbox.query({});
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.subject).toContain('MyProject.csproj');
  });
});

// ── send/ack concurrency (lost-append race regression) ──────────────────────
describe('DefaultMailbox — send racing ack does not lose messages', () => {
  let mailbox: DefaultMailbox;
  let dir: string;

  beforeEach(async () => {
    const m = await createMailbox();
    mailbox = m.mailbox;
    dir = m.dir;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('concurrent sends and acks preserve every message', async () => {
    // Seed one message so acks have something to rewrite the file over.
    const seed = await mailbox.send({
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 'seed',
      body: 'seed',
    });

    // Interleave sends with full-file ack rewrites. Before send() took the
    // same lock ack() rewrites under, an append landing during ack's
    // read→rewrite window was silently erased by the rewrite.
    const N = 20;
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      ops.push(
        mailbox.send({ from: 'a', to: 'b', type: 'note', subject: `m${i}`, body: `${i}` }),
      );
      ops.push(mailbox.ack({ messageId: seed.id, readerId: `reader-${i}` }));
    }
    await Promise.all(ops);

    const all = await mailbox.query({ limit: 1000 });
    const subjects = new Set(all.map((m) => m.subject));
    for (let i = 0; i < N; i++) {
      expect(subjects.has(`m${i}`), `message m${i} was lost`).toBe(true);
    }
    expect(subjects.has('seed')).toBe(true);
  });
});

// ── mail_send / mail_inbox thin tools ────────────────────────────────────────
describe('mail_send + mail_inbox tools', () => {
  let mailbox: DefaultMailbox;
  let dir: string;

  beforeEach(async () => {
    const m = await createMailbox();
    mailbox = m.mailbox;
    dir = m.dir;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trip: agent A broadcasts, agent B reads it once via mail_inbox', async () => {
    const { makeMailSendTool, makeMailInboxTool } = await import(
      '../../src/coordination/mail-tools.js'
    );
    const send = makeMailSendTool({ resolveMailbox: () => mailbox });
    const inbox = makeMailInboxTool({ resolveMailbox: () => mailbox });

    const ctxA = mockCtx({ meta: { agentId: 'coder', agentName: 'Coder' } });
    const ctxB = mockCtx({ meta: { agentId: 'reviewer', agentName: 'Reviewer' } });

    const sent = await send.execute(
      { to: '*', subject: 'auth done', body: 'refactored src/auth — please review' },
      ctxA as never,
    );
    expect(sent.ok).toBe(true);
    expect(sent.from).toBe(`coder@${mailboxSessionTag('default')}`);

    const got = await inbox.execute({}, ctxB as never);
    expect(got.ok).toBe(true);
    expect(got.count).toBe(1);
    expect(got.messages[0]).toMatchObject({
      from: `coder@${mailboxSessionTag('default')}`,
      to: '*',
      type: 'broadcast',
      subject: 'auth done',
    });

    // Read-once: marked read, second inbox call is empty for B…
    const again = await inbox.execute({}, ctxB as never);
    expect(again.count).toBe(0);
    // …but a THIRD agent still sees the broadcast unread (per-id receipts).
    const ctxC = mockCtx({ meta: { agentId: 'tester', agentName: 'Tester' } });
    const cInbox = await inbox.execute({}, ctxC as never);
    expect(cInbox.count).toBe(1);
  });

  it('mail_inbox covers direct, base-alias, and broadcast mail without duplicates', async () => {
    const { makeMailSendTool, makeMailInboxTool } = await import(
      '../../src/coordination/mail-tools.js'
    );
    const send = makeMailSendTool({ resolveMailbox: () => mailbox });
    const inbox = makeMailInboxTool({ resolveMailbox: () => mailbox });
    const ctxA = mockCtx({ meta: { agentId: 'coder' } });
    const ctxB = mockCtx({ meta: { agentId: 'leader' } });
    const uniqueB = `leader@${mailboxSessionTag('default')}`;

    await send.execute({ to: uniqueB, subject: 'direct', body: 'd' }, ctxA as never);
    await send.execute({ to: 'leader', subject: 'alias', body: 'a' }, ctxA as never);
    await send.execute({ to: '*', subject: 'bcast', body: 'b' }, ctxA as never);
    await send.execute({ to: 'someone-else', subject: 'other', body: 'o' }, ctxA as never);

    const got = await inbox.execute({}, ctxB as never);
    expect(got.count).toBe(3);
    const subjects = got.messages.map((m: { subject: string }) => m.subject).sort();
    expect(subjects).toEqual(['alias', 'bcast', 'direct']);
  });

  it('mail_inbox markRead=false peeks without consuming', async () => {
    const { makeMailSendTool, makeMailInboxTool } = await import(
      '../../src/coordination/mail-tools.js'
    );
    const send = makeMailSendTool({ resolveMailbox: () => mailbox });
    const inbox = makeMailInboxTool({ resolveMailbox: () => mailbox });
    const ctxA = mockCtx({ meta: { agentId: 'a' } });
    const ctxB = mockCtx({ meta: { agentId: 'b' } });

    await send.execute({ to: `b@${mailboxSessionTag('default')}`, subject: 's', body: 'x' }, ctxA as never);
    const peek = await inbox.execute({ markRead: false }, ctxB as never);
    expect(peek.count).toBe(1);
    const second = await inbox.execute({}, ctxB as never);
    expect(second.count).toBe(1); // still unread after the peek
  });

  it('mail_send validates required fields', async () => {
    const { makeMailSendTool } = await import('../../src/coordination/mail-tools.js');
    const send = makeMailSendTool({ resolveMailbox: () => mailbox });
    const res = await send.execute({ to: '*' }, mockCtx() as never);
    expect(res.ok).toBe(false);
  });
});
