import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBus } from '../../src/coordination/fleet-bus.js';
import { CollabSession } from '../../src/coordination/collab-debug.js';
import type { BugFinding, CriticEvaluation, RefactorPlan, SharedFileSnapshot } from '../../src/coordination/collab-debug.js';

const bug = (): BugFinding => ({ id: 'b1', type: 'sqli', severity: 'high', location: { file: 'a.ts', line: 3 }, description: 'sql injection', suggestedFix: 'parameterize' });
const plan = (): RefactorPlan => ({ id: 'p1', basedOnBugIds: ['b1'], phases: [{ number: 1, title: 'extract', tasks: ['t'], risk: 'low' }], riskScore: 'medium', estimatedChangeCount: 4, rollbackStrategy: 'revert' });
const evaluation = (verdict: CriticEvaluation['verdict'] = 'reject'): CriticEvaluation => ({ id: 'e1', subjectType: 'bug_finding', subjectId: 'b1', score: 4, verdict, strengths: ['s'], weaknesses: ['w'], concerns: [{ description: 'blocker', severity: 'blocking' }] });

const fleetEvent = (fleetBus: FleetBus, subagentId: string, type: string, payload: unknown) =>
  (fleetBus as unknown as { emit: (e: { subagentId: string; ts: number; type: string; payload: unknown }) => void }).emit({ subagentId, ts: Date.now(), type, payload });

function makeMockDirector(fleetBus: FleetBus, resultFor?: (id: string) => unknown) {
  return {
    id: 'mock-director',
    fleet: fleetBus,
    sharedScratchpadPath: '/tmp/scratch',
    getLeaderBtwNotes: () => [] as string[],
    async spawn(cfg: { role: string }) {
      return `${cfg.role}-0`;
    },
    async assign() {
      return 'task-0';
    },
    async awaitTasks(ids: string[]) {
      return ids.map((id) => ({ taskId: id, subagentId: id, status: 'success' as const, result: resultFor ? resultFor(id) : `done:${id}`, iterations: 1, toolCalls: 0, durationMs: 1 }));
    },
  };
}

let fleetBus: FleetBus;
let tmp: string[] = [];
beforeEach(() => {
  fleetBus = new FleetBus();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmp.map((d) => fs.rm(d, { recursive: true, force: true })));
  tmp = [];
});

const snap = (files: SharedFileSnapshot['files'] = [{ path: 'a.ts', content: 'x' }]): SharedFileSnapshot => ({ id: 'snap', createdAt: new Date().toISOString(), files });

describe('CollabSession getters + simple accessors', () => {
  it('exposes id, alerts, cancelled, subagent map, and file limit', () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    expect(s.id).toBe(s.sessionId);
    expect(s.getSessionAlerts()).toEqual([]);
    expect(s.isCancelled()).toBe(false);
    expect(s.getSubagentIds().size).toBe(0);
    expect(s.effectiveFileLimit()).toBe(30); // default
    const s2 = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap(), maxTargetFiles: 7 });
    expect(s2.effectiveFileLimit()).toBe(7);
    const s3 = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap(), contextWindow: 200_000 });
    expect(s3.effectiveFileLimit()).toBe(Math.max(5, Math.floor((200_000 * 0.4) / 2000)));
  });

  it('budgetForRole honors overrides, defaults, and the unknown-role fallback', () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, {
      targetPaths: ['a.ts'],
      prebuiltSnapshot: snap(),
      budgetOverrides: { 'bug-hunter': { maxIterations: 9, maxToolCalls: 9, timeoutMs: 9 } },
    });
    const call = (role: string) => (s as unknown as { budgetForRole: (r: string) => { maxIterations: number } }).budgetForRole(role);
    expect(call('bug-hunter').maxIterations).toBe(9); // override
    expect(call('critic').maxIterations).toBe(1000); // default
    expect(call('mystery').maxIterations).toBe(1500); // fallback
  });

  it('cancel is idempotent and emits cancel events', () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    const events: string[] = [];
    fleetBus.filter('director.cancel_collab', () => events.push('cancel'));
    s.cancel('first');
    s.cancel('again'); // no-op
    expect(s.isCancelled()).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('roleFromSubagentId resolves via tracked map, prefix fallback, and null', () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    const role = (id: string) => (s as unknown as { roleFromSubagentId: (i: string) => string | null }).roleFromSubagentId(id);
    expect(role('critic-2')).toBe('critic'); // prefix fallback
    expect(role('unrelated-9')).toBeNull();
  });
});

describe('CollabSession.buildSnapshot', () => {
  it('reads target files, detecting language and tolerating unreadable files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-snap-'));
    tmp.push(dir);
    const files = ['a.ts', 'b.js', 'c.md', 'd.json', 'e.txt'];
    for (const f of files) await fs.writeFile(path.join(dir, f), `// ${f}`);
    const targetPaths = [...files.map((f) => path.join(dir, f)), path.join(dir, 'missing.ts')];
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths });
    const result = await s.buildSnapshot();
    const langs = result.files.map((f) => f.language);
    expect(langs).toContain('typescript');
    expect(langs).toContain('javascript');
    expect(langs).toContain('markdown');
    expect(langs).toContain('json');
    // the missing file is captured with empty content (read failure tolerated)
    expect(result.files.find((f) => f.path.endsWith('missing.ts'))?.content).toBe('');
  });

  it('throws when the target exceeds the file limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-limit-'));
    tmp.push(dir);
    await fs.writeFile(path.join(dir, 'only.ts'), 'x');
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: [path.join(dir, 'only.ts')], maxTargetFiles: 0 });
    await expect(s.buildSnapshot()).rejects.toThrow(/exceeds the/);
  });
});

describe('CollabSession.parseAndEmit + report assembly (full start)', () => {
  it('parses agent JSON results into bugs/plans/evaluations and assembles a report', async () => {
    const resultFor = (id: string) => {
      if (id.startsWith('bug-hunter')) return JSON.stringify({ finding: bug() });
      if (id.startsWith('refactor-planner')) return JSON.stringify({ plan: plan() });
      if (id.startsWith('critic')) return JSON.stringify({ evaluation: evaluation('reject') });
      return 'noop';
    };
    // a snapshot whose files reference a missing path + a no-metadata file → exercises freshness checks
    const snapshot = snap([
      { path: '/nope/missing.ts', content: '', snapshotMtimeMs: 1, snapshotSizeBytes: 1 },
      { path: 'no-meta.ts', content: '' },
    ]);
    const s = new CollabSession(makeMockDirector(fleetBus, resultFor) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snapshot, timeoutMs: 5000 });
    const report = await s.start();
    expect(report.bugs).toHaveLength(1);
    expect(report.refactorPlans).toHaveLength(1);
    expect(report.evaluations).toHaveLength(1);
    expect(report.overallVerdict).toBe('reject'); // worst verdict
    expect(report.disposition).toBe('completed');
    expect(report.summary).toContain('Bugs Found');
    expect(report.summary).toContain('Refactor Plans');
    expect(report.summary).toContain('Critic Evaluations');
    expect(report.snapshotWarnings.length).toBeGreaterThan(0); // missing file flagged
  });

  it('parseAndEmit skips non-success and key-less results', async () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    const parse = (r: unknown) => (s as unknown as { parseAndEmit: (r: unknown) => Promise<void> }).parseAndEmit(r);
    await parse({ status: 'failed', result: null });
    await parse({ status: 'success', result: null });
    await parse({ status: 'success', subagentId: 's', taskId: 't', result: 'no json {"other":1} here' }); // no finding/plan/evaluation key
    expect(s.getSessionAlerts()).toEqual([]);
  });
});

describe('CollabSession.wireFleetBus event handlers', () => {
  function wired(onBudgetWarning?: (a: unknown) => 'cancel' | 'extend' | 'ignore') {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, {
      targetPaths: ['a.ts'],
      prebuiltSnapshot: snap(),
      onBudgetWarning: onBudgetWarning as never,
    });
    (s as unknown as { wireFleetBus: () => void }).wireFleetBus();
    return s;
  }
  const budgetPayload = (kind: string, over: Record<string, unknown> = {}) => {
    const cap = { extended: null as Record<string, unknown> | null, denied: false };
    return {
      cap,
      payload: { kind, used: 11, limit: 10, timeoutMs: 1000, extend: (e: Record<string, unknown>) => { cap.extended = e; }, deny: () => { cap.denied = true; }, ...over },
    };
  };
  const tick = () => new Promise((r) => setImmediate(r));

  it('populates bug/plan/evaluation maps from fleet events', () => {
    const s = wired();
    fleetEvent(fleetBus, 'bug-hunter-0', 'bug.found', { finding: bug() });
    fleetEvent(fleetBus, 'refactor-planner-0', 'refactor.plan', { plan: plan() });
    fleetEvent(fleetBus, 'critic-0', 'critic.evaluation', { evaluation: evaluation('approve') });
    fleetEvent(fleetBus, 'bug-hunter-0', 'tool.executed', {});
    const report = (s as unknown as { assembleReport: () => { bugs: unknown[] } }).assembleReport();
    expect(report.bugs).toHaveLength(1);
  });

  it('ignores budget events from an unknown role', () => {
    const s = wired();
    const { cap, payload } = budgetPayload('iterations');
    fleetEvent(fleetBus, 'who-knows-9', 'budget.threshold_reached', payload);
    expect(cap.denied).toBe(false);
    expect(s.getSessionAlerts()).toEqual([]);
  });

  it('cancels the session when the director returns "cancel"', () => {
    const s = wired(() => 'cancel');
    const { payload } = budgetPayload('iterations');
    fleetEvent(fleetBus, 'bug-hunter-0', 'budget.threshold_reached', payload);
    expect(s.isCancelled()).toBe(true);
    expect(s.getSessionAlerts()).toHaveLength(1);
  });

  it('extends each non-timeout kind on an "extend" decision', async () => {
    const _s = wired(() => 'extend');
    for (const kind of ['iterations', 'tool_calls', 'tokens', 'cost']) {
      const { cap, payload } = budgetPayload(kind);
      fleetEvent(fleetBus, 'critic-0', 'budget.threshold_reached', payload);
      await tick();
      expect(cap.extended).not.toBeNull();
    }
  });

  it('auto-extends conservatively on an "ignore" decision', async () => {
    const _s = wired(() => 'ignore');
    const { cap, payload } = budgetPayload('tool_calls');
    fleetEvent(fleetBus, 'critic-0', 'budget.threshold_reached', payload);
    await tick();
    expect(cap.extended?.maxToolCalls).toBeGreaterThan(0);
  });

  it('extends a timeout kind while progress is being made and denies when stuck', async () => {
    const _s = wired();
    // Make progress first so the first timeout extends.
    fleetEvent(fleetBus, 'bug-hunter-0', 'tool.executed', {});
    const first = budgetPayload('timeout');
    fleetEvent(fleetBus, 'bug-hunter-0', 'budget.threshold_reached', first.payload);
    await tick();
    expect(first.cap.extended).not.toBeNull();
    // No new progress → second timeout denies.
    const second = budgetPayload('timeout');
    fleetEvent(fleetBus, 'bug-hunter-0', 'budget.threshold_reached', second.payload);
    await tick();
    expect(second.cap.denied).toBe(true);
  });

  it('handles a director.cancel_collab signal for this session (and ignores others)', () => {
    const s = wired();
    fleetEvent(fleetBus, 'mock-director', 'director.cancel_collab', { sessionId: 'someone-else', reason: 'x' });
    expect(s.isCancelled()).toBe(false);
    fleetEvent(fleetBus, 'mock-director', 'director.cancel_collab', { sessionId: s.sessionId, reason: 'stop' });
    expect(s.isCancelled()).toBe(true);
  });
});

describe('CollabSession edge cases', () => {
  const tick = () => new Promise((r) => setImmediate(r));

  it('rejects a second start() call', async () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap(), timeoutMs: 5000 });
    await s.start();
    await expect(s.start()).rejects.toThrow(/already settled/);
  });

  it('times out and surfaces a session error when agents never complete', async () => {
    const hang = makeMockDirector(fleetBus);
    hang.awaitTasks = () => new Promise(() => {}) as never; // never resolves
    const s = new CollabSession(hang as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap(), timeoutMs: 25 });
    await expect(s.start()).rejects.toThrow(/timed out/);
    expect(s.isCancelled()).toBe(true);
  });

  it('clears the armed timeout timer when an agent task rejects', async () => {
    const failing = makeMockDirector(fleetBus);
    failing.awaitTasks = () => Promise.reject(new Error('agent crashed'));
    const s = new CollabSession(failing as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap(), timeoutMs: 5000 });
    await expect(s.start()).rejects.toThrow('agent crashed');
    expect(s.isCancelled()).toBe(false); // failed via task error, not timeout cancel
  });

  it('extractJsonObjects tolerates escaped quotes and backslashes', async () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    (s as unknown as { wireFleetBus: () => void }).wireFleetBus();
    const json = JSON.stringify({ finding: { id: 'b9', type: 't', severity: 'low', location: { file: 'a.ts', line: 1 }, description: 'a"b\\c' } });
    await (s as unknown as { parseAndEmit: (r: unknown) => Promise<void> }).parseAndEmit({ status: 'success', subagentId: 'bug-hunter-0', taskId: 't', result: json });
    const report = (s as unknown as { assembleReport: () => { bugs: unknown[] } }).assembleReport();
    expect(report.bugs).toHaveLength(1);
  });

  it('auto-extends iterations, tokens, and cost on the ignore path', async () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap(), onBudgetWarning: () => 'ignore' });
    (s as unknown as { wireFleetBus: () => void }).wireFleetBus();
    for (const [kind, field] of [['iterations', 'maxIterations'], ['tokens', 'maxTokens'], ['cost', 'maxCostUsd']] as const) {
      const cap = { extended: null as Record<string, unknown> | null };
      fleetEvent(fleetBus, 'critic-0', 'budget.threshold_reached', { kind, used: 11, limit: 10, extend: (e: Record<string, unknown>) => { cap.extended = e; }, deny: () => {} });
      await tick();
      expect(cap.extended?.[field]).toBeGreaterThan(0);
    }
  });

  it('clears an armed timer on director.cancel_collab', () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    (s as unknown as { wireFleetBus: () => void }).wireFleetBus();
    (s as unknown as { _timeoutTimer: NodeJS.Timeout })._timeoutTimer = setTimeout(() => {}, 10_000);
    fleetEvent(fleetBus, 'mock-director', 'director.cancel_collab', { sessionId: s.sessionId, reason: 'stop' });
    expect(s.isCancelled()).toBe(true);
  });

  it('roleFromSubagentId resolves via the tracked subagent map', () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    (s as unknown as { subagentIds: Map<string, string> }).subagentIds.set('critic', 'sub-xyz');
    expect((s as unknown as { roleFromSubagentId: (i: string) => string | null }).roleFromSubagentId('sub-xyz')).toBe('critic');
  });

  it('reports a cancelled disposition when assembling after cancel', () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    s.cancel('done');
    const report = (s as unknown as { assembleReport: () => { disposition: string } }).assembleReport();
    expect(report.disposition).toBe('cancelled');
  });

  it('checkSnapshotFreshness flags files that changed since the snapshot', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-fresh-'));
    tmp.push(dir);
    const f = path.join(dir, 'changed.ts');
    await fs.writeFile(f, 'a much longer body than the snapshot recorded');
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, {
      targetPaths: [f],
      prebuiltSnapshot: snap([{ path: f, content: '', snapshotMtimeMs: 1, snapshotSizeBytes: 1 }]),
    });
    const warnings = await (s as unknown as { checkSnapshotFreshness: () => Promise<string[]> }).checkSnapshotFreshness();
    expect(warnings.some((w) => w.includes('changed.ts'))).toBe(true);
  });
});

describe('CollabSession.assembleReport markdown sections', () => {
  it('renders alerts and snapshot warnings when present', () => {
    const s = new CollabSession(makeMockDirector(fleetBus) as never, fleetBus, { targetPaths: ['a.ts'], prebuiltSnapshot: snap() });
    // Pre-populate the private state that the markdown summary renders.
    const priv = s as unknown as {
      alerts: unknown[];
      snapshotWarnings: string[];
      bugs: Map<string, BugFinding>;
      plans: Map<string, RefactorPlan>;
      evaluations: Map<string, CriticEvaluation>;
      assembleReport: () => { summary: string };
    };
    priv.alerts.push({ level: 'warning', role: 'bug-hunter', message: 'soft limit' });
    priv.snapshotWarnings = ['a.ts changed after snapshot'];
    priv.bugs.set('b1', bug());
    priv.plans.set('p1', plan());
    priv.evaluations.set('e1', evaluation('needs_revision'));
    const report = priv.assembleReport();
    expect(report.summary).toContain('Alerts');
    expect(report.summary).toContain('Snapshot Warnings');
    expect(report.summary).toContain('Bugs Found');
  });
});
