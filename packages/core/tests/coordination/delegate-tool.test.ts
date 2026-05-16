import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegateTool,
  type DelegateHost,
} from '../../src/coordination/delegate-tool.js';
import { Director } from '../../src/coordination/director.js';
import { FLEET_ROSTER } from '../../src/coordination/fleet.js';
import { EventBus } from '../../src/kernel/events.js';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/**
 * Tests the `delegate` LLM-callable tool. The tool is the
 * one-call-does-everything entry point that auto-promotes the host to
 * director mode if needed, spawns a subagent, assigns the task, and
 * returns the result. These tests cover:
 *
 *  - successful end-to-end delegation through a role
 *  - successful delegation with explicit name/provider/model
 *  - error path: unknown role
 *  - error path: no role + no name
 *  - error path: missing task
 *  - timeout path
 *  - host that refuses promotion (legacy non-director path)
 *  - auto-promotion: ensureDirector returns null then promoteToDirector succeeds
 */

describe('createDelegateTool', () => {
  let director: Director;
  let buses: Map<string, EventBus>;
  let attachDisposers: Array<() => void>;

  beforeEach(() => {
    buses = new Map();
    attachDisposers = [];
  });

  function buildLiveDirector(): Director {
    const runner = vi.fn(
      async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        const bus = buses.get(ctx.subagentId)!;
        bus.emit('iteration.started', { ctx: null as never, index: 1 });
        bus.emit('tool.executed', { id: 'mock', name: 'mock', durationMs: 5, ok: true });
        bus.emit('provider.response', {
          ctx: null as never,
          usage: { input: 100, output: 50 },
          stopReason: 'end_turn',
        });
        return {
          result: `done:${task.description}`,
          iterations: 1,
          toolCalls: 1,
        };
      },
    );
    const d = new Director({
      config: {
        coordinatorId: 'delegate-test',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 4,
      },
      runner,
    });
    // Hook every spawn into a fresh EventBus and wire it to the
    // FleetBus so the in-line runner's events route through.
    const origSpawn = d.spawn.bind(d);
    d.spawn = async (config, priceLookup) => {
      const id = await origSpawn(config, priceLookup);
      const bus = new EventBus();
      buses.set(id, bus);
      attachDisposers.push(d.fleet.attach(id, bus));
      return id;
    };
    return d;
  }

  function buildHost(initial: Director | null, promoted?: Director | null): DelegateHost {
    let live = initial;
    return {
      isDirectorMode: () => !!live,
      ensureDirector: async () => live,
      promoteToDirector: async () => {
        if (live) return live;
        live = promoted ?? null;
        return live;
      },
    };
  }

  it('runs a delegated task end-to-end via roster role', async () => {
    director = buildLiveDirector();
    const tool = createDelegateTool({ host: buildHost(director), roster: FLEET_ROSTER });
    const out = (await tool.execute(
      { role: 'bug-hunter', task: 'audit src/parser.ts' },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean; status?: string; result?: unknown };
    expect(out.ok).toBe(true);
    expect(out.status).toBe('success');
    expect(out.result).toBe('done:audit src/parser.ts');
  });

  it('accepts name + provider + model without a roster role', async () => {
    director = buildLiveDirector();
    const tool = createDelegateTool({ host: buildHost(director), roster: FLEET_ROSTER });
    const out = (await tool.execute(
      { name: 'oneoff', provider: 'anthropic', model: 'claude-haiku', task: 'just do it' },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean; result?: unknown };
    expect(out.ok).toBe(true);
    expect(out.result).toBe('done:just do it');
  });

  it('rejects unknown role with a helpful error', async () => {
    director = buildLiveDirector();
    const tool = createDelegateTool({ host: buildHost(director), roster: FLEET_ROSTER });
    const out = (await tool.execute(
      { role: 'does-not-exist', task: 'x' },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Unknown role/);
  });

  it('rejects when neither role nor name is provided', async () => {
    director = buildLiveDirector();
    const tool = createDelegateTool({ host: buildHost(director), roster: FLEET_ROSTER });
    const out = (await tool.execute(
      { task: 'x' },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/role.*name/i);
  });

  it('rejects when task is missing or empty', async () => {
    director = buildLiveDirector();
    const tool = createDelegateTool({ host: buildHost(director), roster: FLEET_ROSTER });
    const out = (await tool.execute(
      { role: 'bug-hunter' },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/task.*required/i);
  });

  it('auto-promotes when ensureDirector returns null but promote succeeds', async () => {
    director = buildLiveDirector();
    const host = buildHost(null, director); // promoteToDirector will return the director
    const tool = createDelegateTool({ host, roster: FLEET_ROSTER });
    const out = (await tool.execute(
      { role: 'bug-hunter', task: 'scan' },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
  });

  it('fails cleanly when promote is impossible', async () => {
    const host: DelegateHost = {
      isDirectorMode: () => false,
      ensureDirector: async () => null,
      promoteToDirector: async () => null,
    };
    const tool = createDelegateTool({ host, roster: FLEET_ROSTER });
    const out = (await tool.execute(
      { role: 'bug-hunter', task: 'x' },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Director could not be activated/);
  });

  it('returns a timeout error when the subagent does not finish in time', async () => {
    // Custom director whose runner never completes — we'll set a tiny
    // timeout to force the race to resolve to the timeout branch.
    const runner = vi.fn(
      () =>
        new Promise<SubagentRunOutcome>(() => {
          /* never resolves */
        }),
    );
    director = new Director({
      config: {
        coordinatorId: 'hang-director',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      runner,
    });
    const tool = createDelegateTool({
      host: buildHost(director),
      roster: FLEET_ROSTER,
      defaultTimeoutMs: 60_000, // won't be hit; we override per-call below
    });
    const out = (await tool.execute(
      { role: 'bug-hunter', task: 'wait forever', timeoutMs: 50 },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean; stopReason?: string; error?: string };
    expect(out.ok).toBe(false);
    // `timedOut: true` was the old flag; the new return shape uses
    // `stopReason` so the host LLM can distinguish host-side timeout
    // from a subagent-internal timeout, budget exhaustion, abort, etc.
    expect(out.stopReason).toBe('host_timeout');
    expect(out.error).toMatch(/did not finish/);
    await director.shutdown();
  });

  it('exposes roster ids on the input schema enum', () => {
    const tool = createDelegateTool({
      host: buildHost(null),
      roster: FLEET_ROSTER,
    });
    const schema = tool.inputSchema as {
      properties?: { role?: { enum?: string[] } };
    };
    expect(schema.properties?.role?.enum).toEqual(
      expect.arrayContaining(Object.keys(FLEET_ROSTER)),
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // D5/T6 — Partial-output reader robustness on missing/corrupt JSONL
  // ─────────────────────────────────────────────────────────────────
  //
  // When a subagent times out or busts a budget the delegate tool tries
  // to read the per-subagent JSONL transcript to extract `partial`
  // output for the orchestrator LLM. The disk path can be in any state:
  //   - sessionsRoot doesn't exist at all
  //   - sessionsRoot exists but has no run dir for this subagent
  //   - the JSONL is half-flushed and contains a corrupt last line
  // None of these may crash the tool — the orchestrator must still get
  // a structured error (with status='timeout' or kind='budget_*') even
  // if the partial is missing or incomplete.

  it('T6: timeout with missing JSONL transcript still returns structured error', async () => {
    const runner = vi.fn(
      () =>
        new Promise<SubagentRunOutcome>(() => {
          /* never resolves */
        }),
    );
    director = new Director({
      config: {
        coordinatorId: 'partial-test',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      runner,
    });
    const tool = createDelegateTool({
      host: buildHost(director),
      roster: FLEET_ROSTER,
      // Point sessionsRoot at a path that *does not exist* — the reader
      // must catch ENOENT silently and the tool must still return.
      sessionsRoot: '/this/path/definitely/does/not/exist/abcd1234',
      directorRunId: 'phantom-run',
    });
    const out = (await tool.execute(
      { role: 'bug-hunter', task: 'wait forever', timeoutMs: 30 },
      null as never,
      { signal: new AbortController().signal },
    )) as { ok: boolean; stopReason?: string; partial?: unknown; error?: string };

    expect(out.ok).toBe(false);
    expect(out.stopReason).toBe('host_timeout');
    // Partial may be absent when the file isn't found — that's fine, the
    // contract is "don't crash" and "carry stopReason". The orchestrator
    // can fall back to the error message.
    expect(out.error).toBeTruthy();
    await director.shutdown();
  });

  it('T6-b: corrupt JSONL line is skipped, surrounding lines still parse', async () => {
    // Set up an actual on-disk JSONL with a mix of valid + corrupt
    // lines so the reader is exercised end-to-end. The reader uses
    // line-level try/catch so one bad line must not poison the whole
    // file.
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-delegate-t6-'));
    const runId = 'partial-run';
    const subagentDir = path.join(tmpRoot, runId);
    await fs.mkdir(subagentDir, { recursive: true });
    // The subagent id used by the test director must match the file
    // name. The runner stalls forever, so the spawn() side picks an
    // id we can't predict — solve it by writing a JSONL for every
    // possible id-prefix the test might land on: scan after the
    // timeout fires and verify the reader doesn't throw.
    //
    // Simpler: pre-create a JSONL for a known id by overriding spawn
    // to use a stable id. But Director.spawn allocates the id, so
    // we instead seed a JSONL for the directorRunId path and rely on
    // the reader's directorRunId branch which scans the whole run
    // directory.
    //
    // We test the most stress-prone variant: write a known JSONL and
    // a deliberately corrupt last line. The reader should swallow the
    // parse error and still return whatever it could read.
    const jsonl = [
      JSON.stringify({ type: 'session_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'user_input', content: 'investigate' }),
      JSON.stringify({
        type: 'llm_response',
        stopReason: 'tool_use',
        content: [{ type: 'text', text: 'I will check the file.' }],
      }),
      JSON.stringify({ type: 'tool_use', name: 'read' }),
      // Deliberately corrupt — half-flushed line, what you'd see on
      // a crashed writer.
      '{"type":"llm_response","content":[{"type":"text","text":"par',
      JSON.stringify({ type: 'session_end' }),
      '', // trailing blank
    ].join('\n');

    const stubRunner = vi.fn(
      () =>
        new Promise<SubagentRunOutcome>(() => {
          /* never resolves — forces timeout path */
        }),
    );
    director = new Director({
      config: {
        coordinatorId: 'partial-test',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      runner: stubRunner,
    });
    // Intercept Director.spawn so we know the assigned id and can
    // place the JSONL at the right path BEFORE the timeout fires.
    const origSpawn = director.spawn.bind(director);
    director.spawn = async (config, priceLookup) => {
      const id = await origSpawn(config, priceLookup);
      await fs.writeFile(path.join(subagentDir, `${id}.jsonl`), jsonl);
      return id;
    };

    const tool = createDelegateTool({
      host: buildHost(director),
      roster: FLEET_ROSTER,
      sessionsRoot: tmpRoot,
      directorRunId: runId,
    });

    const out = (await tool.execute(
      { role: 'bug-hunter', task: 'investigate', timeoutMs: 30 },
      null as never,
      { signal: new AbortController().signal },
    )) as {
      ok: boolean;
      stopReason?: string;
      partial?: {
        lastAssistantText?: string;
        toolUsesObserved?: number;
        events?: number;
      };
    };

    expect(out.ok).toBe(false);
    expect(out.stopReason).toBe('host_timeout');
    // The reader should have recovered the valid lines. We don't lock
    // in exact counts because the JSONL format may evolve — the
    // contract is "we got SOMETHING back, partial.events > 0".
    expect(out.partial).toBeDefined();
    expect(out.partial?.events).toBeGreaterThan(0);
    // The valid llm_response line carries text → reader should expose it.
    expect(out.partial?.lastAssistantText).toMatch(/check the file/);
    // tool_use should be counted (1).
    expect(out.partial?.toolUsesObserved).toBeGreaterThanOrEqual(1);

    await director.shutdown();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});
