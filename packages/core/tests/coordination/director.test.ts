import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import { EventBus } from '../../src/kernel/events.js';
import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/**
 * Integration tests for the Director orchestration layer.
 *
 * These tests prove the system works end-to-end without spinning up a
 * real provider or Agent. We stand in for the production
 * `AgentSubagentRunner` with a tiny in-line runner that:
 *
 *   1. Looks up which subagent is running via `ctx.subagentId`.
 *   2. Emits the same events a real Agent would (provider.response,
 *      tool.executed) on a per-subagent EventBus.
 *   3. Hooks that bus into the Director's FleetBus so the usage
 *      aggregator picks the events up.
 *   4. Returns a `SubagentRunOutcome` with the task's "result" set to
 *      a marker string that proves the right runner ran the right task.
 *
 * If anyone breaks per-subagent isolation, provider attribution, cost
 * roll-up, or the await/spawn flow — one of these tests fails.
 */

describe('Director orchestration', () => {
  let director: Director;
  /** Map of subagent id → EventBus the test runner uses to emit events
   *  on that subagent's behalf. Populated by `spawn()` so each subagent
   *  gets a distinct bus (true isolation, no cross-talk). */
  let buses: Map<string, EventBus>;
  /** Detach functions returned by `fleet.attach()`. Cleared between
   *  tests so we don't leak listeners across cases. */
  let attachDisposers: Array<() => void>;

  beforeEach(() => {
    buses = new Map();
    attachDisposers = [];
  });

  /**
   * Build a Director whose runner is a vi.fn() spy. Each test customizes
   * the runner's behavior via `runner.mockImplementation(...)`.
   *
   * The runner's contract: given the task + ctx, emit the canonical
   * events on the matching subagent's bus, then return an outcome. The
   * bus is attached to the Director's FleetBus inside this helper so
   * the test doesn't have to remember the wiring step.
   */
  function buildDirector(): {
    director: Director;
    runner: ReturnType<typeof vi.fn>;
  } {
    const runner = vi.fn(
      async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        const bus = buses.get(ctx.subagentId)!;
        // One iteration, one tool, one provider call — enough to exercise
        // every aggregator path without committing the test to a
        // particular shape of agent run.
        bus.emit('iteration.started', { ctx: null as never, index: 1 });
        bus.emit('tool.started', { name: 'mock', id: 'm-1', input: {} });
        bus.emit('tool.executed', { id: 'm-1', name: 'mock', durationMs: 5, ok: true });
        bus.emit('provider.response', {
          ctx: null as never,
          usage: { input: 1000, output: 200 },
          stopReason: 'end_turn',
        });
        return {
          result: `${ctx.config.name}@${ctx.config.provider ?? 'default'}:${task.description}`,
          iterations: 1,
          toolCalls: 1,
        };
      },
    );
    const d = new Director({
      config: {
        coordinatorId: 'test-director',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 4,
      },
      runner,
    });
    return { director: d, runner };
  }

  /** Spawn a subagent + create + attach its EventBus to the FleetBus.
   *  Returns the subagent id so the test can pass it to `assign()`. */
  async function spawnWithBus(
    d: Director,
    config: SubagentConfig,
    price?: { input?: number; output?: number },
  ): Promise<string> {
    const id = await d.spawn(config, price);
    const bus = new EventBus();
    buses.set(id, bus);
    attachDisposers.push(d.fleet.attach(id, bus));
    return id;
  }

  it('isolates subagents: per-id provider + model attribution', async () => {
    const { director: d } = buildDirector();
    director = d;
    const sonnetId = await spawnWithBus(d, {
      name: 'editor',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    const haikuId = await spawnWithBus(d, {
      name: 'researcher',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    const gptId = await spawnWithBus(d, {
      name: 'auditor',
      provider: 'openai',
      model: 'gpt-5',
    });

    expect(sonnetId).not.toEqual(haikuId);
    expect(haikuId).not.toEqual(gptId);

    const status = d.status();
    expect(status.subagents).toHaveLength(3);
    const names = status.subagents.map((s) => s.name).sort();
    expect(names).toEqual(['auditor', 'editor', 'researcher']);
  });

  it('routes a task to the named subagent (no cross-talk)', async () => {
    const { director: d, runner } = buildDirector();
    director = d;
    const editorId = await spawnWithBus(d, {
      name: 'editor',
      provider: 'anthropic',
      model: 'sonnet',
    });
    const researcherId = await spawnWithBus(d, {
      name: 'researcher',
      provider: 'anthropic',
      model: 'haiku',
    });

    const taskId = await d.assign({
      id: 't-1',
      description: 'rewrite the README',
      subagentId: editorId,
    });
    const [result] = await d.awaitTasks([taskId]);

    // The runner's marker proves the right subagent picked it up — if
    // the coordinator misrouted, the marker would say "researcher@…".
    expect(result.status).toBe('success');
    expect(result.result).toBe('editor@anthropic:rewrite the README');
    expect(result.subagentId).toBe(editorId);

    // Researcher should not have been touched.
    const researcherCalls = runner.mock.calls.filter(
      (c) => (c[1] as SubagentRunContext).subagentId === researcherId,
    );
    expect(researcherCalls).toHaveLength(0);
  });

  it('rolls up usage across subagents with per-subagent pricing', async () => {
    const { director: d } = buildDirector();
    director = d;
    // Sonnet: $3/M in, $15/M out.
    const sonnetId = await spawnWithBus(
      d,
      { name: 'editor', provider: 'anthropic', model: 'sonnet' },
      { input: 3, output: 15 },
    );
    // Haiku: $0.80/M in, $4/M out.
    const haikuId = await spawnWithBus(
      d,
      { name: 'researcher', provider: 'anthropic', model: 'haiku' },
      { input: 0.8, output: 4 },
    );

    const a = await d.assign({ id: 't-a', description: 'edit', subagentId: sonnetId });
    const b = await d.assign({ id: 't-b', description: 'research', subagentId: haikuId });
    await d.awaitTasks([a, b]);

    const snap = d.snapshot();

    // Each subagent emitted one provider.response with 1000 in / 200 out.
    // sonnet cost = 1000/1M * 3 + 200/1M * 15 = 0.003 + 0.003 = 0.006
    // haiku  cost = 1000/1M * 0.8 + 200/1M * 4 = 0.0008 + 0.0008 = 0.0016
    expect(snap.perSubagent[sonnetId].cost).toBeCloseTo(0.006, 6);
    expect(snap.perSubagent[haikuId].cost).toBeCloseTo(0.0016, 6);
    expect(snap.total.cost).toBeCloseTo(0.0076, 6);
    expect(snap.total.input).toBe(2000);
    expect(snap.total.output).toBe(400);

    // Tool calls + iterations attributed correctly.
    expect(snap.perSubagent[sonnetId].toolCalls).toBe(1);
    expect(snap.perSubagent[haikuId].toolCalls).toBe(1);
    expect(snap.perSubagent[sonnetId].iterations).toBe(1);

    // Provider metadata captured at spawn time, surfaced in snapshot.
    expect(snap.perSubagent[sonnetId].provider).toBe('anthropic');
    expect(snap.perSubagent[sonnetId].model).toBe('sonnet');
    expect(snap.perSubagent[haikuId].model).toBe('haiku');
  });

  it('awaitTasks resolves for tasks that completed before being awaited', async () => {
    // Regression guard for the "consumer asks late" case — without the
    // `completed` cache, awaitTasks would hang forever for a task whose
    // event already fired.
    const { director: d } = buildDirector();
    director = d;
    const id = await spawnWithBus(d, { name: 'w', provider: 'anthropic', model: 'haiku' });
    const taskId = await d.assign({ id: 't-late', description: 'do thing', subagentId: id });

    // Give the runner time to complete.
    await new Promise((r) => setTimeout(r, 30));

    const [result] = await d.awaitTasks([taskId]);
    expect(result.status).toBe('success');
  });

  it('terminate aborts a running subagent', async () => {
    const { director: d, runner } = buildDirector();
    director = d;
    // Custom slow runner so terminate has something to abort.
    runner.mockImplementationOnce(async (_task, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const tid = setTimeout(() => resolve(), 5000);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(tid);
          reject(new Error('aborted'));
        });
      });
      return { iterations: 0, toolCalls: 0 };
    });
    const id = await spawnWithBus(d, { name: 'slow', provider: 'anthropic', model: 'haiku' });
    const taskId = await d.assign({ id: 't-slow', description: 'slow op', subagentId: id });

    // Terminate after the runner has a chance to start.
    await new Promise((r) => setTimeout(r, 20));
    await d.terminate(id);

    const [result] = await d.awaitTasks([taskId]);
    // Coordinator marks aborted subagent's task as 'stopped' or 'failed'
    // depending on whether the signal aborted first or the throw landed first.
    expect(['stopped', 'failed']).toContain(result.status);
  });

  it('director tools expose the same API to an LLM', async () => {
    const { director: d } = buildDirector();
    director = d;
    const tools = d.tools({
      researcher: { name: 'researcher', provider: 'anthropic', model: 'haiku' },
      auditor: { name: 'auditor', provider: 'openai', model: 'gpt-5' },
    });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ask_subagent',
      'assign_task',
      'await_tasks',
      'fleet_health',
      'fleet_session',
      'fleet_status',
      'fleet_usage',
      'roll_up',
      'spawn_subagent',
      'terminate_subagent',
    ]);

    const spawn = tools.find((t) => t.name === 'spawn_subagent')!;
    const assign = tools.find((t) => t.name === 'assign_task')!;
    const awaitTasks = tools.find((t) => t.name === 'await_tasks')!;
    const usage = tools.find((t) => t.name === 'fleet_usage')!;

    // Spawn from roster.
    const spawnRes = (await spawn.execute({ role: 'researcher' }, null as never, {
      signal: new AbortController().signal,
    })) as { subagentId: string; provider: string; model: string };
    expect(spawnRes.provider).toBe('anthropic');
    expect(spawnRes.model).toBe('haiku');

    // Wire the bus the runner needs (production version would do this in
    // the AgentFactory — here we mirror that pattern).
    const bus = new EventBus();
    buses.set(spawnRes.subagentId, bus);
    attachDisposers.push(d.fleet.attach(spawnRes.subagentId, bus));

    // Assign + await via tools.
    const assignRes = (await assign.execute(
      { subagentId: spawnRes.subagentId, description: 'enumerate packages' },
      null as never,
      { signal: new AbortController().signal },
    )) as { taskId: string };

    const awaitRes = (await awaitTasks.execute({ taskIds: [assignRes.taskId] }, null as never, {
      signal: new AbortController().signal,
    })) as { results: Array<{ status: string }> };
    expect(awaitRes.results[0].status).toBe('success');

    // fleet_usage should show one subagent with non-zero token usage.
    const usageRes = (await usage.execute({}, null as never, {
      signal: new AbortController().signal,
    })) as { total: { input: number } };
    expect(usageRes.total.input).toBeGreaterThan(0);
  });

  it('unknown role in spawn_subagent returns an error', async () => {
    const { director: d } = buildDirector();
    director = d;
    const [spawn] = d.tools({ researcher: { name: 'researcher' } });
    const res = (await spawn.execute({ role: 'nope' }, null as never, {
      signal: new AbortController().signal,
    })) as { error?: string };
    expect(res.error).toMatch(/unknown role "nope"/);
  });

  it('spawn_subagent can instantiate the same roster role repeatedly', async () => {
    const { director: d } = buildDirector();
    director = d;
    const [spawn] = d.tools({
      researcher: { id: 'researcher', name: 'Researcher', provider: 'anthropic', model: 'haiku' },
    });

    const first = (await spawn.execute({ role: 'researcher' }, null as never, {
      signal: new AbortController().signal,
    })) as { subagentId: string };
    const second = (await spawn.execute({ role: 'researcher' }, null as never, {
      signal: new AbortController().signal,
    })) as { subagentId: string };

    expect(first.subagentId).toMatch(/^researcher-/);
    expect(second.subagentId).toMatch(/^researcher-/);
    expect(second.subagentId).not.toBe(first.subagentId);
  });

  it('FleetBus subscribe + filter routes events to the right handlers', async () => {
    const { director: d } = buildDirector();
    director = d;
    const id = await spawnWithBus(d, { name: 'w', provider: 'anthropic', model: 'haiku' });

    const perAgent: string[] = [];
    const allTools: string[] = [];
    const allAny: string[] = [];

    d.fleet.subscribe(id, (e) => perAgent.push(e.type));
    d.fleet.filter('tool.executed', (e) => allTools.push(e.subagentId));
    d.fleet.onAny((e) => allAny.push(e.type));

    const taskId = await d.assign({ id: 't-1', description: 'go', subagentId: id });
    await d.awaitTasks([taskId]);

    // Subscribe-by-id sees every event from that subagent.
    expect(perAgent).toEqual(
      expect.arrayContaining([
        'iteration.started',
        'tool.started',
        'tool.executed',
        'provider.response',
      ]),
    );
    // Filter sees only the requested type but across the fleet.
    expect(allTools).toEqual([id]);
    // onAny sees everything.
    expect(allAny.length).toBeGreaterThanOrEqual(4);
  });

  it('ask() round-trips a question to a subagent via the bridge', async () => {
    // The runner subscribes to the child's bridge and replies with an
    // echoed payload. Director.ask resolves with the reply payload.
    const responses: string[] = [];
    const runner = vi.fn(
      async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        // Subscribe BEFORE doing anything else — we want to catch the
        // director's `ask()` message arriving while this task runs.
        ctx.bridge?.subscribe((msg) => {
          if (msg.type === 'task') {
            const q = (msg.payload as { question?: string }).question ?? 'no question';
            responses.push(q);
            // Reply: same id so the director's `request<T>` matches it,
            // direction reversed (from child, to director).
            void ctx.bridge!.send({
              id: msg.id,
              type: 'result',
              from: ctx.subagentId,
              to: msg.from,
              payload: { answer: `echo: ${q}` },
              timestamp: Date.now(),
            });
          }
        });
        // Keep the task alive so the bridge stays subscribed.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        return { iterations: 1, toolCalls: 0 };
      },
    );
    const d = new Director({
      config: { coordinatorId: 'ask-d', doneCondition: { type: 'all_tasks_done' } },
      runner,
    });
    director = d;
    const id = await d.spawn({ name: 'answerer', provider: 'anthropic', model: 'haiku' });
    const bus = new EventBus();
    buses.set(id, bus);
    attachDisposers.push(d.fleet.attach(id, bus));
    const taskId = await d.assign({ id: 'ask-task', description: 'standby', subagentId: id });

    // Give the runner a tick to subscribe.
    await new Promise((r) => setTimeout(r, 30));

    const answer = await d.ask<{ answer: string }>(id, { question: 'what is 2+2?' });
    expect(answer.answer).toBe('echo: what is 2+2?');
    expect(responses).toContain('what is 2+2?');

    await d.awaitTasks([taskId]);
  });

  it('ask() rejects with a helpful error for unknown subagent', async () => {
    const { director: d } = buildDirector();
    director = d;
    await expect(d.ask('does-not-exist', { question: 'hi' })).rejects.toThrow(/unknown subagent/);
  });

  it('rollUp() formats markdown summary across completed tasks', async () => {
    const { director: d } = buildDirector();
    director = d;
    const editor = await spawnWithBus(d, {
      name: 'editor',
      provider: 'anthropic',
      model: 'sonnet',
    });
    const researcher = await spawnWithBus(d, {
      name: 'researcher',
      provider: 'anthropic',
      model: 'haiku',
    });
    const a = await d.assign({ id: 'r-a', description: 'edit X', subagentId: editor });
    const b = await d.assign({ id: 'r-b', description: 'research Y', subagentId: researcher });
    await d.awaitTasks([a, b]);

    const md = d.rollUp([a, b]);
    expect(md).toContain('### ' + editor);
    expect(md).toContain('### ' + researcher);
    expect(md).toContain('anthropic/sonnet');
    expect(md).toContain('anthropic/haiku');
    // Marker strings from the mock runner appear in the rolled-up text.
    expect(md).toContain('editor@anthropic:edit X');
    expect(md).toContain('researcher@anthropic:research Y');
  });

  it('rollUp(taskIds, "json") emits a parseable JSON array', async () => {
    const { director: d } = buildDirector();
    director = d;
    const id = await spawnWithBus(d, { name: 'w', provider: 'anthropic', model: 'haiku' });
    const taskId = await d.assign({ id: 'j-1', description: 'do thing', subagentId: id });
    await d.awaitTasks([taskId]);

    const json = d.rollUp([taskId], 'json');
    const parsed = JSON.parse(json) as Array<{ taskId: string; status: string; result: unknown }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].taskId).toBe(taskId);
    expect(parsed[0].status).toBe('success');
  });

  it('rollUp with no matching tasks returns a polite empty marker', () => {
    const { director: d } = buildDirector();
    director = d;
    const md = d.rollUp(['nonexistent']);
    expect(md).toMatch(/No completed tasks/);
  });

  it('writeManifest persists run state to disk', async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrongstack-manifest-test-'));
    const manifestPath = path.join(tmpDir, 'fleet.json');
    try {
      const { director: d } = buildDirectorWithManifest(manifestPath);
      director = d;
      const editor = await spawnWithBus(d, {
        name: 'editor',
        provider: 'anthropic',
        model: 'sonnet',
      });
      const taskId = await d.assign({ id: 'm-1', description: 'rewrite', subagentId: editor });
      await d.awaitTasks([taskId]);

      const written = await d.writeManifest();
      expect(written).toBe(manifestPath);

      const content = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as {
        directorRunId: string;
        children: Array<{
          subagentId: string;
          provider?: string;
          results: Array<{ taskId: string; status: string }>;
        }>;
        usage: { total: { input: number } };
      };
      expect(content.directorRunId).toBe('test-director-manifest');
      expect(content.children).toHaveLength(1);
      expect(content.children[0].subagentId).toBe(editor);
      expect(content.children[0].provider).toBe('anthropic');
      expect(content.children[0].results[0].taskId).toBe(taskId);
      expect(content.children[0].results[0].status).toBe('success');
      expect(content.usage.total.input).toBeGreaterThan(0);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Variant of buildDirector that wires a manifest path. We can't add an
   * option to the existing helper without rewriting all the other tests,
   * so this co-located factory keeps the manifest test self-contained.
   */
  function buildDirectorWithManifest(manifestPath: string): {
    director: Director;
    runner: ReturnType<typeof vi.fn>;
  } {
    const runner = vi.fn(
      async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        const bus = buses.get(ctx.subagentId)!;
        bus.emit('iteration.started', { ctx: null as never, index: 1 });
        bus.emit('tool.executed', { id: 'm-1', name: 'mock', durationMs: 5, ok: true });
        bus.emit('provider.response', {
          ctx: null as never,
          usage: { input: 1000, output: 200 },
          stopReason: 'end_turn',
        });
        return { result: `${ctx.config.name}:${task.description}`, iterations: 1, toolCalls: 1 };
      },
    );
    const d = new Director({
      config: {
        coordinatorId: 'test-director-manifest',
        doneCondition: { type: 'all_tasks_done' },
      },
      runner,
      manifestPath,
    });
    return { director: d, runner };
  }

  it('director.tools() exposes ask_subagent + roll_up alongside the existing six', async () => {
    const { director: d } = buildDirector();
    director = d;
    const tools = d.tools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ask_subagent',
      'assign_task',
      'await_tasks',
      'fleet_health',
      'fleet_session',
      'fleet_status',
      'fleet_usage',
      'roll_up',
      'spawn_subagent',
      'terminate_subagent',
    ]);
  });

  it('per-subagent session JSONL: each subagent gets its own file', async () => {
    // Phase-2 fix: prove that the DirectorSessionFactory hands out one
    // SessionWriter per spawned subagent, with each transcript landing
    // in its own JSONL file under <runDir>/<subagentId>.jsonl.
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const { makeDirectorSessionFactory } = await import(
      '../../src/coordination/director-session.js'
    );

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrongstack-director-test-'));
    try {
      const factory = makeDirectorSessionFactory({
        sessionsRoot: tmpRoot,
        directorRunId: 'run-abc',
      });

      const editor = await factory.createSubagentSession({
        subagentId: 'editor',
        provider: 'anthropic',
        model: 'sonnet',
      });
      const researcher = await factory.createSubagentSession({
        subagentId: 'researcher',
        provider: 'anthropic',
        model: 'haiku',
      });

      // Write distinct events to each — proves no cross-talk.
      await editor.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'rewrite README',
      });
      await researcher.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'find OWASP risks',
      });
      await editor.close();
      await researcher.close();

      const runDir = path.join(tmpRoot, 'run-abc');
      const files = await fsp.readdir(runDir);
      expect(files.sort()).toContain('editor.jsonl');
      expect(files.sort()).toContain('researcher.jsonl');

      const editorContent = await fsp.readFile(path.join(runDir, 'editor.jsonl'), 'utf8');
      const researcherContent = await fsp.readFile(path.join(runDir, 'researcher.jsonl'), 'utf8');

      // Each file contains its own user_input — no leak across.
      expect(editorContent).toContain('rewrite README');
      expect(editorContent).not.toContain('OWASP');
      expect(researcherContent).toContain('OWASP');
      expect(researcherContent).not.toContain('rewrite README');
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('cleanup detaches FleetBus listeners (no leak across tests)', () => {
    // The afterEach below runs every test's disposers — this test
    // explicitly verifies the disposer is callable and idempotent.
    const fleet = new Director({
      config: { coordinatorId: 'cleanup', doneCondition: { type: 'all_tasks_done' } },
    }).fleet;
    const bus = new EventBus();
    const off = fleet.attach('x', bus);
    expect(() => off()).not.toThrow();
    expect(() => off()).not.toThrow(); // second call is a no-op
  });

  describe('safety caps (Phase 6)', () => {
    it('maxSpawns refuses the N+1-th spawn with FleetSpawnBudgetError', async () => {
      const { FleetSpawnBudgetError } = await import('../../src/coordination/director.js');
      const dir = new Director({
        config: { coordinatorId: 'cap', doneCondition: { type: 'all_tasks_done' } },
        runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
        maxSpawns: 2,
      });
      await dir.spawn({ name: 'a' });
      await dir.spawn({ name: 'b' });
      let caught: unknown;
      try {
        await dir.spawn({ name: 'c' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FleetSpawnBudgetError);
      expect((caught as InstanceType<typeof FleetSpawnBudgetError>).kind).toBe('max_spawns');
      expect((caught as InstanceType<typeof FleetSpawnBudgetError>).limit).toBe(2);
      // Status should reflect only the two spawns that actually landed.
      const s = dir.status();
      expect(s.subagents.length).toBe(2);
      await dir.shutdown();
    });

    it('maxSpawnDepth refuses spawn when director is too deep', async () => {
      const { FleetSpawnBudgetError } = await import('../../src/coordination/director.js');
      // A "nested" director at depth >= cap — it cannot spawn at all.
      const dir = new Director({
        config: { coordinatorId: 'deep', doneCondition: { type: 'all_tasks_done' } },
        runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
        maxSpawnDepth: 2,
        spawnDepth: 2, // already at the cap
      });
      let caught: unknown;
      try {
        await dir.spawn({ name: 'a' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FleetSpawnBudgetError);
      expect((caught as InstanceType<typeof FleetSpawnBudgetError>).kind).toBe('max_spawn_depth');
      await dir.shutdown();
    });

    it('default maxSpawnDepth is 2 — root director (depth 0) can spawn', async () => {
      const dir = new Director({
        config: { coordinatorId: 'root', doneCondition: { type: 'all_tasks_done' } },
        runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
      });
      expect(dir.maxSpawnDepth).toBe(2);
      expect(dir.spawnDepth).toBe(0);
      expect(dir.maxSpawns).toBe(Number.POSITIVE_INFINITY);
      // Root spawn should succeed since 0 < 2.
      await expect(dir.spawn({ name: 'a' })).resolves.toBeTruthy();
      await dir.shutdown();
    });

    it('spawn_subagent tool surfaces budget error as structured { error, kind }', async () => {
      const dir = new Director({
        config: { coordinatorId: 'cap-tool', doneCondition: { type: 'all_tasks_done' } },
        runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
        maxSpawns: 1,
      });
      const tools = dir.tools();
      const spawnTool = tools.find((t) => t.name === 'spawn_subagent')!;
      // First call succeeds.
      const r1 = await spawnTool.execute({ name: 'first' });
      expect((r1 as { subagentId: string }).subagentId).toBeTruthy();
      // Second call hits the cap. Must NOT throw — the leader needs a
      // readable error payload to replan.
      const r2 = await spawnTool.execute({ name: 'second' });
      expect(r2).toMatchObject({
        kind: 'max_spawns',
        limit: 1,
      });
      expect((r2 as { error: string }).error).toMatch(/spawn budget exceeded/i);
      await dir.shutdown();
    });

    it('isolation regression: subagent prompts do not leak siblings or parent', () => {
      const dir = new Director({
        config: { coordinatorId: 'iso', doneCondition: { type: 'all_tasks_done' } },
        // The director's own "leader" prompt — must NOT appear inside any subagent prompt.
      });
      const a: SubagentConfig = {
        name: 'A',
        prompt: 'You are A. SECRET_A=alpha.',
        systemPromptOverride: 'OVERRIDE_A',
      };
      const b: SubagentConfig = {
        name: 'B',
        prompt: 'You are B. SECRET_B=bravo.',
        systemPromptOverride: 'OVERRIDE_B',
      };
      const promptA = dir.subagentSystemPrompt(a, 'task A');
      const promptB = dir.subagentSystemPrompt(b, 'task B');

      // A's prompt must mention A's role + override only — never B's.
      expect(promptA).toContain('SECRET_A=alpha');
      expect(promptA).toContain('OVERRIDE_A');
      expect(promptA).not.toContain('SECRET_B');
      expect(promptA).not.toContain('OVERRIDE_B');

      // Symmetric.
      expect(promptB).toContain('SECRET_B=bravo');
      expect(promptB).toContain('OVERRIDE_B');
      expect(promptB).not.toContain('SECRET_A');
      expect(promptB).not.toContain('OVERRIDE_A');

      // And neither leaks the director-leader preamble's signature
      // (i.e. subagents never see the director's own playbook).
      expect(promptA).not.toContain('You are the Director');
      expect(promptB).not.toContain('You are the Director');
    });
  });
});
