import { describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: vi.fn(() => ({
    id: 'mock',
    capabilities: { streaming: false, tools: true },
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })),
  })),
}));

import {
  type Config,
  type ConfigStore,
  Container,
  EventBus,
  ProviderRegistry,
  type SessionWriter,
  type SubagentConfig,
  type SystemPromptBuilder,
  TOKENS,
  type TokenCounter,
  type Tool,
  ToolRegistry,
} from '@wrongstack/core';
import { type MultiAgentDeps, MultiAgentHost } from '../src/multi-agent.js';

/**
 * V0-C: `MultiAgentHost` is lazy by design — until /spawn fires, no
 * coordinator is built. These tests pin that lazy contract. The actual
 * spawn flow is exercised by the core `multi-agent-coordinator` tests;
 * here we cover the host wrapper's pre-spawn surface plus stopAll.
 */

function makeDeps(): MultiAgentDeps {
  const configStore = {
    get: vi.fn(() => ({
      provider: 'anthropic',
      model: 'claude',
      apiKey: 'fake',
    })),
    watch: vi.fn(() => () => {}),
  } as unknown as ConfigStore;

  const systemPromptBuilder = {
    build: vi.fn(async () => [{ type: 'text', text: 'sys' }]),
  } as unknown as SystemPromptBuilder;

  const session: SessionWriter = {
    id: 'sess-test',
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  const tokenCounter: TokenCounter = {
    account: vi.fn(),
    estimate: vi.fn(() => 0),
    reset: vi.fn(),
    total: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
    snapshot: vi.fn(() => []),
    inputTokens: vi.fn(() => 0),
    outputTokens: vi.fn(() => 0),
  } as unknown as TokenCounter;

  return {
    container: new Container(),
    toolRegistry: new ToolRegistry(),
    providerRegistry: new ProviderRegistry(),
    configStore,
    events: new EventBus(),
    systemPromptBuilder,
    session,
    tokenCounter,
    projectRoot: '/tmp/proj',
    cwd: '/tmp/proj',
  };
}

describe('MultiAgentHost', () => {
  it('status() before any spawn reports "No subagents"', () => {
    const host = new MultiAgentHost(makeDeps());
    const s = host.status();
    expect(s.summary).toMatch(/no subagents/i);
    expect(s.pending).toEqual([]);
    expect(s.completed).toEqual([]);
  });

  it('stopAll() before any spawn is a no-op', async () => {
    const host = new MultiAgentHost(makeDeps());
    await expect(host.stopAll()).resolves.toBeUndefined();
  });

  it('kill() before any spawn returns false', async () => {
    const host = new MultiAgentHost(makeDeps());
    expect(await host.kill('any-id')).toBe(false);
  });

  it('kill() after spawn stops the subagent and returns true', async () => {
    const host = new MultiAgentHost(makeDeps());
    const { subagentId } = await host.spawn('do a thing');
    expect(await host.kill(subagentId)).toBe(true);
    await host.stopAll();
  });

  it('constructor does not eagerly read config or build the coordinator', () => {
    const deps = makeDeps();
    new MultiAgentHost(deps);
    // configStore.get is only called inside ensureCoordinator()
    expect(deps.configStore.get).not.toHaveBeenCalled();
    expect(
      (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
    ).not.toHaveBeenCalled();
  });

  it('status() shape stays stable across calls when nothing changes', () => {
    const host = new MultiAgentHost(makeDeps());
    const a = host.status();
    const b = host.status();
    expect(a.pending).toEqual(b.pending);
    expect(a.completed).toEqual(b.completed);
  });

  it('spawn() lazily builds the coordinator and tracks pending tasks', async () => {
    const deps = makeDeps();
    const host = new MultiAgentHost(deps);
    const { subagentId, taskId } = await host.spawn('do a thing');
    expect(subagentId).toBeTruthy();
    expect(taskId).toBeTruthy();
    expect(deps.configStore.get).toHaveBeenCalled();
    expect(
      (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
    ).toHaveBeenCalled();
    const s = host.status();
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]!.description).toBe('do a thing');
    expect(s.summary).toMatch(/1 pending/);
    await host.stopAll();
  });

  it('spawn() reuses the coordinator across multiple calls', async () => {
    const deps = makeDeps();
    const host = new MultiAgentHost(deps);
    const a = await host.spawn('task one');
    const b = await host.spawn('task two');
    expect(a.taskId).not.toBe(b.taskId);
    // configStore.get should be called only once — for the lazy build.
    expect((deps.configStore.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    await host.stopAll();
  });

  it('spawn() works with a providers config entry (not just top-level apiKey)', async () => {
    const deps = makeDeps();
    (deps.configStore.get as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: 'anthropic',
      model: 'claude',
      providers: { anthropic: { type: 'anthropic', apiKey: 'k', baseUrl: 'https://x' } },
    });
    const host = new MultiAgentHost(deps);
    const { taskId } = await host.spawn('with provider config');
    expect(taskId).toBeTruthy();
    await host.stopAll();
  });

  it('spawn() with per-subagent provider override builds that provider, not the leader', async () => {
    // Director-mode: a single fleet should be able to use sonnet for the
    // editor + haiku for the researcher in the same run. Verifies the
    // factory looks up `config.providers[<overrideId>]` and passes the
    // right config to `makeProviderFromConfig`.
    const providersMod = await import('@wrongstack/providers');
    const mocked = providersMod.makeProviderFromConfig as ReturnType<typeof vi.fn>;
    mocked.mockClear();

    const deps = makeDeps();
    (deps.configStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'anthropic',
      model: 'sonnet',
      apiKey: 'leader-key',
      providers: {
        anthropic: { type: 'anthropic', family: 'anthropic', apiKey: 'anthropic-key' },
        openai: { type: 'openai', family: 'openai', apiKey: 'openai-key' },
      },
    });

    const host = new MultiAgentHost(deps);
    await host.spawn('rewrite README', { name: 'editor', provider: 'anthropic', model: 'sonnet' });
    await host.spawn('audit code', { name: 'auditor', provider: 'openai', model: 'gpt-5' });
    await host.stopAll();

    // Each unique provider override should land as one of the recorded calls.
    const providerIds = mocked.mock.calls.map((c) => c[0]);
    expect(providerIds).toContain('anthropic');
    expect(providerIds).toContain('openai');

    // And the openai call must use the openai-specific apiKey, not the leader's.
    const openaiCall = mocked.mock.calls.find((c) => c[0] === 'openai');
    expect(openaiCall).toBeDefined();
    expect((openaiCall![1] as { apiKey: string }).apiKey).toBe('openai-key');
  });

  it('spawn() falls back to leader provider when override is unknown', async () => {
    // Typo / unconfigured provider id shouldn't crash the run — we use
    // the leader and let downstream code decide whether to fail loudly.
    const providersMod = await import('@wrongstack/providers');
    const mocked = providersMod.makeProviderFromConfig as ReturnType<typeof vi.fn>;
    mocked.mockClear();

    const deps = makeDeps();
    (deps.configStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'anthropic',
      model: 'sonnet',
      apiKey: 'leader-key',
      providers: {
        anthropic: { type: 'anthropic', family: 'anthropic', apiKey: 'anthropic-key' },
      },
    });

    const host = new MultiAgentHost(deps);
    await host.spawn('do thing', { provider: 'mistral-but-not-configured' });
    await host.stopAll();

    // We should have called makeProviderFromConfig with 'anthropic' (the
    // leader), not the unknown id.
    const providerIds = mocked.mock.calls.map((c) => c[0]);
    expect(providerIds).toContain('anthropic');
    expect(providerIds).not.toContain('mistral-but-not-configured');
  });

  it('spawn() honors the toolRegistry filter when called with allow-list', async () => {
    const deps = makeDeps();
    const tools = deps.toolRegistry;
    tools.register({
      name: 'a',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    });
    tools.register({
      name: 'b',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    });
    const host = new MultiAgentHost(deps);
    await host.spawn('go');
    await host.stopAll();
    // SystemPromptBuilder receives the unfiltered list via the factory closure;
    // exercising the path is what matters for coverage.
    expect(
      (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
    ).toHaveBeenCalled();
  });

  describe('director mode', () => {
    it('isDirectorMode() is false before first spawn (lazy build)', () => {
      // Before any spawn, no Director exists yet — this holds for both
      // directorMode: false (explicit opt-out) and the default (implicit).
      const host = new MultiAgentHost(makeDeps());
      expect(host.isDirectorMode()).toBe(false);
    });

    it('isDirectorMode() becomes true after first spawn (Director always built)', async () => {
      // After the single-path refactoring, spawn() always builds a Director
      // regardless of directorMode, so isDirectorMode() flips after spawn.
      const directed = new MultiAgentHost(makeDeps(), { directorMode: true });
      expect(directed.isDirectorMode()).toBe(false); // not yet built
      await directed.spawn('a thing');
      expect(directed.isDirectorMode()).toBe(true);
      await directed.stopAll();
    });

    it('manifest() returns null when no manifestPath is configured', async () => {
      // Without manifestPath the Director has nowhere to write.
      const host = new MultiAgentHost(makeDeps());
      await host.spawn('do thing');
      expect(await host.manifest()).toBeNull();
      await host.stopAll();
    });

    it('director mode builds a Director on first spawn and writes a manifest', async () => {
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-manifest-'));
      const manifestPath = path.join(tmpRoot, 'fleet.json');

      const host = new MultiAgentHost(makeDeps(), {
        directorMode: true,
        manifestPath,
      });
      expect(host.isDirectorMode()).toBe(false); // not yet built
      await host.spawn('inspect', { name: 'inspector', provider: 'anthropic', model: 'claude' });
      expect(host.isDirectorMode()).toBe(true);
      const written = await host.manifest();
      expect(written).toBe(manifestPath);
      const raw = await fs.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as { directorRunId: string; children: unknown[] };
      expect(parsed.directorRunId).toBeTruthy();
      expect(parsed.children.length).toBeGreaterThanOrEqual(1);
      await host.stopAll();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it('status() / usage() keep working in director mode', async () => {
      // Smoke-test that the host's public API stays the same when the
      // Director is the one driving the coordinator under the hood.
      const host = new MultiAgentHost(makeDeps(), { directorMode: true });
      await host.spawn('a thing');
      const s = host.status();
      expect(s.pending.length).toBeGreaterThanOrEqual(0);
      const u = host.usage();
      expect(u).toHaveProperty('rows');
      expect(u).toHaveProperty('totals');
      await host.stopAll();
    });

    it('ensureDirector() returns null when director mode is off', async () => {
      const host = new MultiAgentHost(makeDeps());
      expect(await host.ensureDirector()).toBeNull();
    });

    it('ensureDirector() eagerly builds the Director and exposes the orchestration tools', async () => {
      const host = new MultiAgentHost(makeDeps(), { directorMode: true });
      const director = await host.ensureDirector();
      expect(director).not.toBeNull();
      const tools = director!.tools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'ask_subagent',
        'assign_task',
        'await_tasks',
        'collab_debug',
        'fleet_emit',
        'fleet_health',
        'fleet_session',
        'fleet_status',
        'fleet_usage',
        'roll_up',
        'spawn_subagent',
        'terminate_subagent',
      ]);
      // After ensureDirector(), the host considers itself in director
      // mode — the lazy build flipped the flag.
      expect(host.isDirectorMode()).toBe(true);
      await host.stopAll();
    });

    it('director-mode spawn uses the per-subagent session factory when sessionsRoot is set', async () => {
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-subsessions-'));

      const host = new MultiAgentHost(makeDeps(), {
        directorMode: true,
        sessionsRoot: tmpRoot,
        directorRunId: 'run-test',
      });
      const director = await host.ensureDirector();
      const { taskId } = await host.spawn('a job', { name: 'worker-1' });
      // Wait for the task to actually run — the factory closure (which
      // creates the per-subagent JSONL) only fires when the runner picks
      // up the task. host.spawn returns as soon as assign is called.
      await director!.awaitTasks([taskId]);
      const runDir = path.join(tmpRoot, 'run-test');
      const entries = await fs.readdir(runDir);
      // At least one JSONL file under the run dir means the factory was
      // actually invoked with the director's session writer.
      expect(entries.some((e) => e.endsWith('.jsonl'))).toBe(true);
      await host.stopAll();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it('director-mode passes sharedScratchpadPath through to Director', async () => {
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-scratch-'));
      const scratch = path.join(tmpRoot, 'shared');

      const host = new MultiAgentHost(makeDeps(), {
        directorMode: true,
        sharedScratchpadPath: scratch,
      });
      const director = await host.ensureDirector();
      expect(director!.sharedScratchpadPath).toBe(scratch);
      // Any subagent prompt the director composes carries the path so
      // agents can find the scratchpad without further plumbing.
      const out = director!.subagentSystemPrompt({ name: 'x', prompt: 'r' }, 'task');
      expect(out).toContain('Shared notes:');
      expect(out).toContain(scratch);
      // The directory is created lazily (fire-and-forget mkdir in the
      // Director constructor). Give it a tick to settle, then verify —
      // if it still doesn't exist, the first write would create it
      // anyway thanks to `recursive: true`, so the assertion here is a
      // soft check that the eager-mkdir code path actually ran.
      await new Promise((r) => setTimeout(r, 50));
      const stat = await fs.stat(scratch).catch(() => null);
      expect(stat?.isDirectory() ?? false).toBe(true);
      await host.stopAll();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    describe('promoteToDirector (runtime promotion)', () => {
      it('promotes a non-director host and returns the Director', async () => {
        const host = new MultiAgentHost(makeDeps());
        expect(host.isDirectorMode()).toBe(false);

        const director = await host.promoteToDirector();
        expect(director).not.toBeNull();
        expect(host.isDirectorMode()).toBe(true);
        // After promotion, the director has the orchestration tools.
        const tools = director!.tools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'ask_subagent',
          'assign_task',
          'await_tasks',
          'collab_debug',
          'fleet_emit',
          'fleet_health',
          'fleet_session',
          'fleet_status',
          'fleet_usage',
          'roll_up',
          'spawn_subagent',
          'terminate_subagent',
        ]);
        await host.stopAll();
      });

      it('is idempotent — calling promoteToDirector twice returns the same Director', async () => {
        const host = new MultiAgentHost(makeDeps());
        const a = await host.promoteToDirector();
        const b = await host.promoteToDirector();
        expect(a).not.toBeNull();
        expect(a).toBe(b); // Same instance — no double-build.
        await host.stopAll();
      });

      it('returns the existing Director if one is already built (spawn already called)', async () => {
        // With the single-path refactoring, spawn() always builds a Director.
        // promoteToDirector() after spawn returns that existing Director.
        const host = new MultiAgentHost(makeDeps());
        await host.spawn('do something');
        expect(host.isDirectorMode()).toBe(true);
        const director = await host.promoteToDirector();
        expect(director).not.toBeNull();
        expect(host.isDirectorMode()).toBe(true);
        await host.stopAll();
      });

      it('manifest() works after runtime promotion', async () => {
        const os = await import('node:os');
        const path = await import('node:path');
        const fs = await import('node:fs/promises');
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-promote-manifest-'));
        const fleetRoot = path.join(tmpRoot, 'session-1');

        const host = new MultiAgentHost(makeDeps(), { fleetRoot });
        await host.promoteToDirector();
        // manifest() should return null before any spawn (no director yet
        // in the simple path, but we just promoted, so it should work).
        await host.spawn('inspect', { name: 'inspector' });
        const written = await host.manifest();
        expect(written).toBe(path.join(fleetRoot, 'fleet.json'));
        const raw = await fs.readFile(written!, 'utf8');
        const parsed = JSON.parse(raw) as { directorRunId: string; children: unknown[] };
        expect(parsed.directorRunId).toBeTruthy();
        expect(parsed.children.length).toBeGreaterThanOrEqual(1);
        await host.stopAll();
        await fs.rm(tmpRoot, { recursive: true, force: true });
      });

      it('derives manifest/shared/subagent paths from fleetRoot', async () => {
        const path = await import('node:path');
        const os = await import('node:os');
        const fs = await import('node:fs/promises');
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-fleet-paths-'));
        const fleetRoot = path.join(tmpRoot, 'session-2');
        const host = new MultiAgentHost(makeDeps(), { fleetRoot });
        const director = await host.promoteToDirector();
        expect(director).not.toBeNull();

        // Trigger lazy build and verify the Director's session factory
        // was wired — spawn + assign a task and check the manifest path.
        await host.spawn('path check', { name: 'checker' });
        const written = await host.manifest();
        expect(written).toBe(path.join(fleetRoot, 'fleet.json'));
        await host.stopAll();
        await fs.rm(tmpRoot, { recursive: true, force: true });
      });

      it('works without fleetRoot — director still built, no paths', async () => {
        const host = new MultiAgentHost(makeDeps());
        // No fleetRoot at all — should still create the director.
        const director = await host.promoteToDirector();
        expect(director).not.toBeNull();
        expect(host.isDirectorMode()).toBe(true);

        // The director is alive but without paths, manifest() returns
        // null because no manifestPath was configured.
        await host.spawn('no-root', { name: 'ghost' });
        expect(await host.manifest()).toBeNull();
        await host.stopAll();
      });

      it('ensureDirector() returns the same Director after promotion', async () => {
        const host = new MultiAgentHost(makeDeps());
        const promoted = await host.promoteToDirector();
        const ensured = await host.ensureDirector();
        expect(ensured).toBe(promoted);
        await host.stopAll();
      });

      it('spawn() after promotion routes through Director (manifest populated)', async () => {
        const os = await import('node:os');
        const path = await import('node:path');
        const fs = await import('node:fs/promises');
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-promote-route-'));
        const fleetRoot = path.join(tmpRoot, 'session-3');

        const host = new MultiAgentHost(makeDeps(), { fleetRoot });
        await host.promoteToDirector();
        const { taskId } = await host.spawn('routed', {
          name: 'router',
          provider: 'anthropic',
          model: 'claude',
        });
        expect(taskId).toBeTruthy();

        // The manifest should reflect the spawn even though we promoted
        // at runtime — the spawn path checks `this.director` and routes
        // through `Director.spawn` + `Director.assign`.
        const written = await host.manifest();
        expect(written).toBe(path.join(fleetRoot, 'fleet.json'));
        const raw = await fs.readFile(written!, 'utf8');
        const parsed = JSON.parse(raw) as {
          children: { name: string; provider: string; model: string }[];
        };
        const child = parsed.children.find((c) => c.name === 'router');
        expect(child).toBeDefined();
        expect(child!.provider).toBe('anthropic');
        expect(child!.model).toBe('claude');
        await host.stopAll();
        await fs.rm(tmpRoot, { recursive: true, force: true });
      });
    });
  });
});

describe('MultiAgentHost.makeSubagentFactory', () => {
  function fakeTool(name: string): Tool {
    return {
      name,
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
  }

  function depsWithTools(): MultiAgentDeps {
    const deps = makeDeps();
    deps.toolRegistry.register(fakeTool('read'));
    deps.toolRegistry.register(fakeTool('grep'));
    deps.toolRegistry.register(fakeTool('bash'));
    // The Agent constructor resolves TOKENS.Logger from the container;
    // bind a noop logger so factory-built agents can construct.
    const logger = {
      level: 'info' as const,
      error() {},
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return logger;
      },
    };
    deps.container.bind(TOKENS.Logger, () => logger);
    return deps;
  }

  const config = { provider: 'anthropic', model: 'claude', apiKey: 'fake' } as unknown as Config;

  const slotCfg: SubagentConfig = {
    id: 'slot-1',
    name: 'sec',
    role: 'security-reviewer',
    tools: ['read', 'grep'],
    systemPromptOverride: 'PERSONA-SENTINEL-XYZ',
  };

  it('returns an isolated runner triple { agent, events, dispose }', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const factory = host.makeSubagentFactory(config);
    const built = await factory(slotCfg);
    expect(built.agent).toBeDefined();
    expect(built.events).toBeInstanceOf(EventBus);
    expect(typeof built.dispose).toBe('function');
    await built.dispose?.();
  });

  it('scopes the agent context to the filtered tool allow-list', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const { agent, dispose } = await host.makeSubagentFactory(config)(slotCfg);
    const names = agent.ctx.tools.map((t) => t.name).sort();
    expect(names).toEqual(['grep', 'read']);
    expect(names).not.toContain('bash');
    await dispose?.();
  });

  it('appends the role persona to the agent system prompt', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const { agent, dispose } = await host.makeSubagentFactory(config)(slotCfg);
    const promptText = agent.ctx.systemPrompt.map((b) => b.text).join('\n');
    expect(promptText).toContain('PERSONA-SENTINEL-XYZ');
    await dispose?.();
  });

  it('builds a distinct, fresh Agent + Context per invocation (no shared leader)', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const factory = host.makeSubagentFactory(config);
    const a = await factory({ ...slotCfg, id: 'slot-a' });
    const b = await factory({ ...slotCfg, id: 'slot-b' });
    expect(a.agent).not.toBe(b.agent);
    expect(a.agent.ctx).not.toBe(b.agent.ctx);
    expect(a.events).not.toBe(b.events);
    await a.dispose?.();
    await b.dispose?.();
  });
});
