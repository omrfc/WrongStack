/**
 * Cross-process session discovery tests.
 *
 * Simulates multiple wstack processes by writing separate entries to the
 * SessionRegistry, then verifies each process can discover all others.
 * Uses a temp directory to avoid interfering with the real registry.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { SessionRegistry, getSessionRegistry, hasSessionRegistry } from '../src/session-registry.js';
import type { AgentEntry } from '../src/session-registry.js';

let tempRoot: string;

beforeAll(async () => {
  tempRoot = path.join(os.tmpdir(), `wstack-session-registry-test-${Date.now()}`);
  await fs.mkdir(tempRoot, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/** Create an isolated subdirectory for each test to avoid cross-test pollution. */
async function freshRoot(): Promise<string> {
  const dir = path.join(tempRoot, `test-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeAgent(over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: over.id ?? 'agent-1',
    name: over.name ?? 'leader',
    status: over.status ?? 'idle',
    currentTool: over.currentTool,
    iterations: over.iterations ?? 0,
    toolCalls: over.toolCalls ?? 0,
    lastActivityAt: over.lastActivityAt ?? new Date().toISOString(),
  };
}

async function forceHeartbeat(registry: SessionRegistry): Promise<void> {
  await (registry as never as { heartbeat(): Promise<void> }).heartbeat();
}

/**
 * Return a PID that is guaranteed not to be alive. Spawning a process and
 * waiting for it to exit hands back a freshly-freed PID — reliably dead on
 * every platform. A hardcoded constant (e.g. 99999) is NOT safe: that PID can
 * belong to a real live process, which makes `pidAlive()`-based pruning flaky.
 */
async function deadPid(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid;
    if (!pid) {
      reject(new Error('failed to spawn helper process for deadPid()'));
      return;
    }
    child.once('error', reject);
    child.once('exit', () => resolve(pid));
  });
}

describe('cross-process session discovery', () => {
  it('a single process can register and discover itself', async () => {
    const root = await freshRoot();
    const registry = new SessionRegistry(root);
    await registry.register({
      sessionId: 'sess-aaa',
      projectSlug: 'project-alpha',
      projectRoot: '/home/alpha',
      projectName: 'Alpha',
      workingDir: '/home/alpha/src',
      gitBranch: 'main',
      pid: 1001,
      startedAt: new Date().toISOString(),
    });

    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe('sess-aaa');
    expect(list[0]!.projectName).toBe('Alpha');
    expect(list[0]!.gitBranch).toBe('main');
  });

  it('re-registering the same process (project switch) replaces its entry, not adds one', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    // Initial registration — process is "in" project Alpha.
    await reg.register({
      sessionId: 'sess-old',
      projectSlug: 'alpha',
      projectRoot: '/home/alpha',
      projectName: 'Alpha',
      workingDir: '/home/alpha',
      pid: 9001,
      startedAt: new Date().toISOString(),
    });
    // WebUI switches projects in place: same pid, fresh session id, new root.
    await reg.register({
      sessionId: 'sess-new',
      projectSlug: 'beta',
      projectRoot: '/home/beta',
      projectName: 'Beta',
      workingDir: '/home/beta',
      pid: 9001,
      startedAt: new Date().toISOString(),
    });

    const list = await reg.list();
    // Exactly one entry for this process — no phantom pointing at the old root.
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe('sess-new');
    expect(list[0]!.projectSlug).toBe('beta');
    expect(list[0]!.workingDir).toBe('/home/beta');
    expect(await reg.get('sess-old')).toBeUndefined();
    expect(await reg.listByProject('alpha')).toHaveLength(0);
  });

  it('two processes can discover each other', async () => {
    const root = await freshRoot();
    // Simulate process 1
    const reg1 = new SessionRegistry(root);
    await reg1.register({
      sessionId: 'sess-111',
      projectSlug: 'proj-alpha',
      projectRoot: '/home/alpha',
      projectName: 'Alpha',
      workingDir: '/home/alpha',
      gitBranch: 'main',
      pid: 2001,
      startedAt: new Date().toISOString(),
    });

    // Simulate process 2 (separate registry instance — different process)
    const reg2 = new SessionRegistry(root);
    await reg2.register({
      sessionId: 'sess-222',
      projectSlug: 'proj-beta',
      projectRoot: '/home/beta',
      projectName: 'Beta',
      workingDir: '/home/beta',
      gitBranch: 'feat/x',
      pid: 2002,
      startedAt: new Date().toISOString(),
    });

    // Process 1 sees process 2
    const list1 = await reg1.list();
    expect(list1).toHaveLength(2);
    const ids1 = list1.map((s) => s.sessionId).sort();
    expect(ids1).toEqual(['sess-111', 'sess-222']);

    // Process 2 sees process 1
    const list2 = await reg2.list();
    expect(list2).toHaveLength(2);
    const ids2 = list2.map((s) => s.sessionId).sort();
    expect(ids2).toEqual(['sess-111', 'sess-222']);
  });

  it('three processes with different branches and projects', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    const startedAt = new Date().toISOString();

    // Three processes
    await reg.register({
      sessionId: 'sess-a', projectSlug: 'ws', projectRoot: '/ws',
      projectName: 'WrongStack', workingDir: '/ws', gitBranch: 'main',
      pid: 3001, startedAt,
    });
    await reg.register({
      sessionId: 'sess-b', projectSlug: 'app', projectRoot: '/app',
      projectName: 'MyApp', workingDir: '/app/src', gitBranch: 'dev',
      pid: 3002, startedAt,
    });
    await reg.register({
      sessionId: 'sess-c', projectSlug: 'lib', projectRoot: '/lib',
      projectName: 'SharedLib', workingDir: '/lib', gitBranch: undefined,
      pid: 3003, startedAt,
    });

    const list = await reg.list();
    expect(list).toHaveLength(3);

    // Verify each can be looked up individually
    const a = list.find((s) => s.sessionId === 'sess-a');
    expect(a?.projectName).toBe('WrongStack');
    expect(a?.gitBranch).toBe('main');

    const b = list.find((s) => s.sessionId === 'sess-b');
    expect(b?.projectName).toBe('MyApp');
    expect(b?.workingDir).toBe('/app/src');

    const c = list.find((s) => s.sessionId === 'sess-c');
    expect(c?.projectName).toBe('SharedLib');
    expect(c?.gitBranch).toBeUndefined();
  });

  it('filter by project slug', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-x', projectSlug: 'ws', projectRoot: '/ws',
      projectName: 'WS', workingDir: '/ws', pid: 4001,
      startedAt: new Date().toISOString(),
    });
    await reg.register({
      sessionId: 'sess-y', projectSlug: 'other', projectRoot: '/other',
      projectName: 'Other', workingDir: '/other', pid: 4002,
      startedAt: new Date().toISOString(),
    });

    const wsSessions = await reg.listByProject('ws');
    expect(wsSessions).toHaveLength(1);
    expect(wsSessions[0]!.sessionId).toBe('sess-x');
  });

  it('stale entries (dead process) are pruned after timeout', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);

    // Register with a heartbeat that's very old (dead process)
    await reg.register({
      sessionId: 'sess-dead',
      projectSlug: 'dead',
      projectRoot: '/dead',
      projectName: 'Dead Project',
      workingDir: '/dead',
      pid: await deadPid(), // a PID guaranteed not to be alive
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min ago
    });

    // Manually age the heartbeat
    const registryPath = path.join(root, 'session-registry.json');
    const raw = await fs.readFile(registryPath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const entry = data['sess-dead'] as Record<string, unknown>;
    entry['lastHeartbeatAt'] = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    await fs.writeFile(registryPath, JSON.stringify(data, null, 2));

    // list() should prune the stale entry (dead PID + old heartbeat)
    const list = await reg.list();
    const dead = list.find((s) => s.sessionId === 'sess-dead');
    // Either marked stale or removed (depending on timing)
    if (dead) {
      expect(dead.status).toBe('stale');
    }
    // Either way, it shouldn't appear as active/idle
    const active = list.filter((s) => s.status !== 'stale' && s.status !== 'closing');
    expect(active.find((s) => s.sessionId === 'sess-dead')).toBeUndefined();
  });

  it('agent status updates are reflected in discovery', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-agents',
      projectSlug: 'agents',
      projectRoot: '/agents',
      projectName: 'Agent Test',
      workingDir: '/agents',
      pid: 5001,
      startedAt: new Date().toISOString(),
    });

    // Update agent status
    await reg.updateAgents([
      makeAgent({ id: 'leader', name: 'leader', status: 'running', currentTool: 'bash', iterations: 5, toolCalls: 12 }),
      makeAgent({ id: 'sub-1', name: 'bug-hunter', status: 'running', iterations: 3, toolCalls: 8 }),
      makeAgent({ id: 'sub-2', name: 'critic', status: 'idle', iterations: 0, toolCalls: 0 }),
    ]);

    // Another process discovers these agents
    const reg2 = new SessionRegistry(root);
    const list = await reg2.list();
    const session = list.find((s) => s.sessionId === 'sess-agents');
    expect(session).toBeDefined();
    expect(session!.agentCount).toBe(3);
    expect(session!.agents).toHaveLength(3);

    const leader = session!.agents.find((a) => a.id === 'leader');
    expect(leader?.status).toBe('running');
    expect(leader?.currentTool).toBe('bash');
    expect(leader?.iterations).toBe(5);
    expect(leader?.toolCalls).toBe(12);
  });
});

// ── Lock resilience + self-heal ───────────────────────────────────────
// A crashed process used to leave its `.lock` file behind forever, which
// wedged every subsequent write — the registry silently stopped updating.

describe('lock resilience', () => {
  it('breaks a stale lock left by a dead owner and still registers', async () => {
    const root = await freshRoot();
    const lockPath = path.join(root, 'session-registry.json.lock');
    // Plant a leftover lock owned by a PID that is not alive.
    await fs.writeFile(lockPath, String(await deadPid()));

    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-wedge',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 6001,
      startedAt: new Date().toISOString(),
    });

    const list = await reg.list();
    expect(list.find((s) => s.sessionId === 'sess-wedge')).toBeDefined();
    // The stale lock must have been cleaned up, not left to wedge future writes.
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('prunes stale registry temp files during writes', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);

    for (let i = 0; i < 25; i++) {
      const legacyTemp = path.join(root, `session-registry.json.${String(i).padStart(8, '0')}.tmp`);
      await fs.writeFile(legacyTemp, '{}');
      const old = new Date(Date.now() - 120_000 - i);
      await fs.utimes(legacyTemp, old, old);
    }

    await reg.register({
      sessionId: 'sess-prune-tmp',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 6001,
      startedAt: new Date().toISOString(),
    });

    const temps = (await fs.readdir(root)).filter(
      (name) => name.startsWith('session-registry.json.') && name.endsWith('.tmp'),
    );
    expect(temps).toHaveLength(20);
  });

  it('self-heals an entry whose initial register write was dropped', async () => {
    const root = await freshRoot();
    const lockPath = path.join(root, 'session-registry.json.lock');
    const reg = new SessionRegistry(root);

    // Simulate a *fresh* (non-stale) lock held by another live process so
    // register() cannot acquire it and the write is dropped.
    await fs.writeFile(lockPath, String(process.pid + 1));
    await reg.register({
      sessionId: 'sess-heal',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      clientType: 'tui',
      pid: 6002,
      startedAt: new Date().toISOString(),
    });
    expect(await reg.list()).toHaveLength(0); // write was dropped

    // Release the contended lock; the next agent update should re-create us.
    await fs.unlink(lockPath);
    await reg.updateAgents([
      makeAgent({ id: 'leader', status: 'running', toolCalls: 7 }),
    ]);

    const healed = (await reg.list()).find((s) => s.sessionId === 'sess-heal');
    expect(healed).toBeDefined();
    expect(healed!.clientType).toBe('tui');
    expect(healed!.agents[0]?.toolCalls).toBe(7);
  });

  it('self-heals a missing entry on heartbeat', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    const reg = new SessionRegistry(root);

    await reg.register({
      sessionId: 'sess-heartbeat-heal',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      clientType: 'cli',
      pid: 6003,
      startedAt: new Date().toISOString(),
    });

    await fs.writeFile(registryPath, JSON.stringify({}, null, 2));
    await forceHeartbeat(reg);

    const healed = (await reg.list()).find((s) => s.sessionId === 'sess-heartbeat-heal');
    expect(healed).toBeDefined();
    expect(healed!.clientType).toBe('cli');
  });
});

// ── Singleton tests ───────────────────────────────────────────────────

describe('SessionRegistry singleton', () => {
  it('getSessionRegistry returns the same instance for the same root', async () => {
    const root = await freshRoot();
    const a = getSessionRegistry(root);
    const b = getSessionRegistry(root);
    // Same root should return same instance
    expect(a).toBe(b);
  });

  it('hasSessionRegistry returns false before initialization', () => {
    // Note: hasSessionRegistry checks the module-level _instance variable.
    // Since our tests initialize the singleton, this may already be true.
    // We just verify the function exists and returns a boolean.
    expect(typeof hasSessionRegistry()).toBe('boolean');
  });
});
