/**
 * Smoke test — full dependency watcher → mailbox → tech-stack round-trip.
 * Verifies the complete pipeline works end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DefaultMailbox } from '../../src/coordination/mailbox.js';
import { GlobalMailbox } from '../../src/coordination/global-mailbox.js';
import { makeMailboxTool } from '../../src/coordination/mailbox-tool.js';
import { makeDependencyWatcherConfig } from '../../src/coordination/dep-watcher.js';

describe('mailbox end-to-end smoke test', () => {
  let tmpRoot: string;
  let sessionDir: string;
  let mailbox: DefaultMailbox;
  let mockCtx: Record<string, unknown>;

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), `ws-smoke-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(tmpRoot, { recursive: true });
    sessionDir = path.join(tmpRoot, 'session');
    await fs.mkdir(sessionDir, { recursive: true });
    mailbox = new DefaultMailbox(sessionDir);
    mockCtx = {
      meta: {},
      session: { transcriptPath: path.join(sessionDir, 'session.jsonl') },
    };
  });

  afterEach(async () => {
    // Best-effort cleanup of the per-test temp dir.
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('full round-trip: dep-watcher → mailbox → tech-stack → result', async () => {
    // ── Step 1: Simulate file watcher detecting package.json change ────
    const watcherCfg = makeDependencyWatcherConfig({
      projectRoot: tmpRoot,
      mailbox,
      targetAgent: 'tech-stack',
      watcherAgentId: 'dep-watcher',
      debounceMs: 10,
    });

    await watcherCfg.onChange({
      path: path.join(tmpRoot, 'package.json'),
      event: 'change',
      timestamp: new Date().toISOString(),
    });

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 60));

    // ── Step 2: Tech-stack agent checks mailbox ────────────────────────
    const techStackTool = makeMailboxTool({
      resolveMailbox: () => mailbox,
      agentId: 'tech-stack',
    });

    const checkResult = await techStackTool.execute(
      { action: 'check' },
      mockCtx as any,
    );

    expect(checkResult.ok).toBe(true);
    expect(checkResult.count).toBeGreaterThanOrEqual(1);
    const msg = checkResult.messages[0];
    expect(msg.type).toBe('assign');
    expect(msg.body).toContain('package.json');
    expect(msg.from).toBe('dep-watcher');

    // ── Step 3: Tech-stack agent ack's the task ────────────────────────
    const ackResult = await techStackTool.execute(
      {
        action: 'ack',
        messageId: msg.id,
        completed: true,
        outcome: 'All packages current. No issues.',
      },
      mockCtx as any,
    );
    expect(ackResult.ok).toBe(true);

    // ── Step 4: Tech-stack agent posts result back ─────────────────────
    const sendResult = await techStackTool.execute(
      {
        action: 'send',
        to: 'dep-watcher',
        type: 'result',
        subject: 'Audit complete',
        body: 'package.json audit passed.',
      },
      mockCtx as any,
    );
    expect(sendResult.ok).toBe(true);

    // ── Step 5: Verify complete round-trip ─────────────────────────────
    const allMsgs = await mailbox.query({});
    expect(allMsgs.length).toBeGreaterThanOrEqual(2);

    // Assign message should be completed
    const assignMsgs = await mailbox.query({ type: 'assign' });
    const completedAssign = assignMsgs.find((m) => m.completed);
    expect(completedAssign).toBeDefined();

    // Cleanup
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('mailbox status discovers agents across the fleet', async () => {
    // Post status from two agents
    const tool1 = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'worker-1' });
    const tool2 = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'worker-2' });

    await tool1.execute({
      action: 'send', to: '*', type: 'status',
      subject: 'Auditing package.json', body: '',
    }, mockCtx as any);

    await tool2.execute({
      action: 'send', to: '*', type: 'status',
      subject: 'Scanning for bugs', body: '',
    }, mockCtx as any);

    // Director checks status
    const dirTool = makeMailboxTool({ resolveMailbox: () => mailbox, agentId: 'director' });
    const statusResult = await dirTool.execute({ action: 'status' }, mockCtx as any);
    expect(statusResult.ok).toBe(true);
    expect(statusResult.count).toBeGreaterThanOrEqual(2);

    // Cleanup
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('cross-session: two sessions share the same project mailbox', async () => {
    // Simulate a real project directory
    const projectDir = path.join(tmpRoot, '.wrongstack', 'projects', 'testproj-a1b2c3');
    await fs.mkdir(projectDir, { recursive: true });

    // Session A — terminal 1
    const mbA = new GlobalMailbox(projectDir);
    const toolA = makeMailboxTool({ resolveMailbox: () => mbA, agentId: 'leader-sessA' });
    const ctxA = { meta: { sessionId: 'sess-A', agentId: 'leader-sessA', agentName: 'Leader A' }, session: { id: 'sess-A' } };

    // Session B — terminal 2  
    const mbB = new GlobalMailbox(projectDir);
    const toolB = makeMailboxTool({ resolveMailbox: () => mbB, agentId: 'leader-sessB' });
    const ctxB = { meta: { sessionId: 'sess-B', agentId: 'leader-sessB', agentName: 'Leader B' }, session: { id: 'sess-B' } };

    // Session A sends a message to session B's leader
    const sendResult = await toolA.execute({
      action: 'send', to: 'leader-sessB', type: 'ask',
      subject: 'Cross-session test', body: 'Can you see this from another terminal?',
    }, ctxA as any);
    expect(sendResult.ok).toBe(true);

    // Session B checks mailbox — should see the message
    const checkB = await toolB.execute({ action: 'check' }, ctxB as any);
    expect(checkB.ok).toBe(true);
    expect(checkB.count).toBeGreaterThanOrEqual(1);
    const msg = checkB.messages[0];
    expect(msg.from).toBe('leader-sessA');
    expect(msg.readByMe).toBe(true); // auto-read on check

    // Session B replies
    const replyResult = await toolB.execute({
      action: 'send', to: 'leader-sessA', type: 'result',
      subject: 'Re: Cross-session test', body: 'Yes, got it!',
    }, ctxB as any);
    expect(replyResult.ok).toBe(true);

    // Session A checks — should see the reply
    const checkA = await toolA.execute({ action: 'check' }, ctxA as any);
    expect(checkA.ok).toBe(true);
    expect(checkA.count).toBeGreaterThanOrEqual(1);

    // Both agents should appear in online list
    const statusA = await toolA.execute({ action: 'online' }, ctxA as any);
    expect(statusA.ok).toBe(true);
    const agentIds = statusA.agents.map((a: { agentId: string }) => a.agentId);
    expect(agentIds).toContain('leader-sessA');
    expect(agentIds).toContain('leader-sessB');

    // Unread count for session A
    const unreadA = await toolA.execute({ action: 'unread' }, ctxA as any);
    expect(unreadA.ok).toBe(true);
    expect(typeof unreadA.count).toBe('number');

    // Cleanup
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('dep-watcher-bridge: file-watcher event → mailbox notification', async () => {
    // Simulate an event bus with onPattern support
    const listeners = new Map<string, Array<(event: string, payload: unknown) => void>>();
    const mockEvents = {
      onPattern(pattern: string, fn: (event: string, payload: unknown) => void) {
        if (!listeners.has(pattern)) listeners.set(pattern, []);
        listeners.get(pattern)!.push(fn);
        return () => {
          const arr = listeners.get(pattern);
          if (arr) {
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
          }
        };
      },
      emitCustom(event: string, payload: unknown) {
        for (const [pattern, fns] of listeners) {
          if (event === pattern) {
            for (const fn of fns) fn(event, payload);
          }
        }
      },
    };

    const { attachDepWatcherBridge } = await import('../../src/coordination/dep-watcher-bridge.js');

    const dispose = attachDepWatcherBridge({
      events: mockEvents as any,
      mailbox,
      projectRoot: tmpRoot,
      targetAgent: 'tech-stack',
      watcherAgentId: 'dep-watcher',
      debounceMs: 10,
    });

    // Simulate file-watcher plugin emitting a change event
    mockEvents.emitCustom('file-watcher:changed', {
      watchId: 'watch_1',
      path: path.join(tmpRoot, 'package.json'),
      event: 'change',
      filename: 'package.json',
      timestamp: new Date().toISOString(),
    });

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 60));

    // Verify the mailbox received the assign message
    const msgs = await mailbox.query({ to: 'tech-stack', type: 'assign' });
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.body).toContain('package.json');
    expect(msgs[0]!.from).toBe('dep-watcher');

    // Non-dependency files should be ignored
    mockEvents.emitCustom('file-watcher:changed', {
      watchId: 'watch_1',
      path: path.join(tmpRoot, 'src', 'index.ts'),
      event: 'change',
      filename: 'index.ts',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 30));
    const allMsgs = await mailbox.query({ to: 'tech-stack' });
    expect(allMsgs.length).toBe(1); // still just the one package.json message

    dispose();

    // Cleanup
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});
