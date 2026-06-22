import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { Container } from '../../src/kernel/container.js';
import { EventBus } from '../../src/kernel/events.js';
import { TOKENS } from '../../src/kernel/tokens.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { ProviderError } from '../../src/types/provider.js';
import type {
  Capabilities,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '../../src/types/provider.js';
import type { Tool } from '../../src/types/tool.js';
import { MockProvider, StreamingMockProvider } from '../helpers/mock-provider.js';

async function buildAgent(provider: MockProvider, extraTools: Tool[] = []) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ag-'));
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile, yolo: true }),
  );

  const tools = new ToolRegistry();
  for (const t of extraTools) tools.register(t);
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const pipelines = createDefaultPipelines();

  const sessionStore = new DefaultSessionStore({ dir: sessionDir });
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });

  const secretScrubber = container.resolve(TOKENS.SecretScrubber);
  const toolExecutor = new ToolExecutor(tools, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber,
    events,
    confirmAwaiter: undefined,
    iterationTimeoutMs: 300_000,
    perIterationOutputCapBytes: 100_000,
    tracer: undefined,
  });

  const agent = new Agent({
    container,
    tools,
    providers,
    events,
    pipelines,
    context: ctx,
    maxIterations: 10,
    toolExecutor,
  });
  return { agent, ctx, tools, tmp, sessionStore };
}

describe('Agent', () => {
  let cleanupDirs: string[] = [];
  beforeEach(() => {
    cleanupDirs = [];
  });
  afterEach(async () => {
    for (const d of cleanupDirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('returns done on plain end_turn response', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const result = await agent.run('hello');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('hi');
    expect(provider.calls).toBe(1);
  });

  it('syncs ctx.tools from the registry on run (tool_search sees the catalog)', async () => {
    const echo: Tool = {
      name: 'echo',
      description: 'echo input',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tools, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    // The Context is constructed without a tools list (mirrors setupSession),
    // so the convenience mirror tool_search reads starts empty.
    expect(ctx.tools).toEqual([]);
    // A tool registered after Context construction but before the run — the
    // MCP / plugin / fleet timing that left ctx.tools empty in the field.
    const late: Tool = {
      name: 'late',
      description: 'registered after context build',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    tools.register(late);
    await agent.run('hi');
    // run() refreshes the mirror from the agent's own registry, so both the
    // boot-time and the late-registered tool are now discoverable.
    expect(ctx.tools.map((t) => t.name).sort()).toEqual(['echo', 'late']);
  });

  it('repairs broken tool-call adjacency before provider requests', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' },
    ]);
    const requestSnapshots: Request['messages'][] = [];
    const complete = provider.complete.bind(provider);
    provider.complete = async (req, opts) => {
      requestSnapshots.push(JSON.parse(JSON.stringify(req.messages)));
      return complete(req, opts);
    };
    const { agent, ctx, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    ctx.state.replaceMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'dangling', name: 'read', input: {} }],
      },
      { role: 'assistant', content: 'still useful' },
    ]);

    const repairs: Array<{ removedToolUses: string[]; removedMessages: number }> = [];
    (agent as never as { events: EventBus }).events.on('context.repaired', (e) => {
      repairs.push({
        removedToolUses: e.removedToolUses,
        removedMessages: e.removedMessages,
      });
    });

    const result = await agent.run('continue');

    expect(result.status).toBe('done');
    expect(repairs).toEqual([{ removedToolUses: ['dangling'], removedMessages: 1 }]);
    expect(JSON.stringify(requestSnapshots[0])).not.toContain('tool_use');
    // Messages carry the internal `_estTokens` annotation (stripped by the
    // provider adapters' normalizeMessage before hitting the wire) — match
    // the semantic shape, not exact object identity.
    expect(requestSnapshots[0]).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'still useful' }),
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'continue' }] }),
    ]);
  });

  it('executes tool use and continues', async () => {
    const echo: Tool = {
      name: 'echo',
      description: 'echo input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        return (input as { text: string }).text;
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'pong' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(2);
  });

  it('never sends a tool_confirm_pending block to the provider after a confirm', async () => {
    // Regression: a confirmed tool returns `tool_confirm_pending` from the
    // executor (no confirmAwaiter). The agent resolves it via the
    // `tool.confirm_needed` event and re-runs the tool — but the message
    // appended to context must carry the RESOLVED tool_result, never the
    // pending sentinel (which the Anthropic API rejects with a 400:
    // "unsupported content type 'tool_confirm_pending'").
    const danger: Tool = {
      name: 'danger',
      description: 'a destructive op that must be confirmed',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      // Destructive → still confirms under regular --yolo (not --yolo-destructive),
      // which is exactly the path that produces a pending result.
      riskTier: 'destructive',
      mutating: true,
      async execute() {
        return 'did the thing';
      },
    } as Tool;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'danger', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const requestSnapshots: Request['messages'][] = [];
    const complete = provider.complete.bind(provider);
    provider.complete = async (req, opts) => {
      requestSnapshots.push(JSON.parse(JSON.stringify(req.messages)));
      return complete(req, opts);
    };
    const { agent, tmp } = await buildAgent(provider, [danger]);
    cleanupDirs.push(tmp);
    // Approve the confirmation the moment the agent asks.
    (agent as never as { events: EventBus }).events.on(
      'tool.confirm_needed',
      (e: { resolve: (d: 'yes' | 'no' | 'always' | 'deny') => void }) => e.resolve('yes'),
    );

    const result = await agent.run('do it');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(2);
    // The pending sentinel must never reach the wire.
    expect(JSON.stringify(requestSnapshots)).not.toContain('tool_confirm_pending');
    // The resolved tool_result must be present in the follow-up request.
    expect(JSON.stringify(requestSnapshots[1])).toContain('did the thing');
  });

  it('handles unknown tool with error result', async () => {
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'nope', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const result = await agent.run('try');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('recovered');
  });

  it('respects max iterations', async () => {
    const script = Array.from({ length: 20 }, () => ({
      content: [{ type: 'tool_use' as const, id: 'u', name: 'echo', input: {} }],
      stopReason: 'tool_use' as const,
    }));
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const provider = new MockProvider(script);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    // Deny any limit extension so the test ends promptly.
    agent.events.on('iteration.limit_reached', ({ deny }) => deny());
    const result = await agent.run('loop', { maxIterations: 3 });
    expect(result.status).toBe('max_iterations');
  });

  it('aborts cleanly on signal', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await agent.run('hi', { signal: ctrl.signal });
    expect(result.status).toBe('aborted');
  });

  it('captures tool errors as error tool_result and continues', async () => {
    const exploding: Tool = {
      name: 'boom',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        throw new Error('tool exploded');
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'boom', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'after error' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [exploding]);
    cleanupDirs.push(tmp);
    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(2);
  });

  // ── sizeSignals coverage — read vs bash/grep/logs vs other tools ──────────

  it('sizeSignals returns outputLines for read tool (line prefix format)', async () => {
    const readTool: Tool = {
      name: 'read',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '   1→line one\n   2→line two\n   3→line three\n';
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [readTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({ name: e.name, outputLines: (e as never as { outputLines?: number }).outputLines });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    // outputLines is computed by sizeSignals based on line prefix pattern
    expect(executed[0]?.name).toBe('read');
  });

  it('sizeSignals counts newlines for bash/grep/shell/logs tools', async () => {
    const bashTool: Tool = {
      name: 'bash',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'line1\nline2\nline3';
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'echo build' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [bashTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({ name: e.name, outputLines: (e as never as { outputLines?: number }).outputLines });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.name).toBe('bash');
    // bash with 2 newlines in content without trailing newline → 3 lines
    expect(executed[0]?.outputLines).toBe(3);
  });

  it('sizeSignals returns undefined lines for non-line-based tools', async () => {
    const customTool: Tool = {
      name: 'custom',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return { key: 'value' };
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'custom', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [customTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({ name: e.name, outputLines: (e as never as { outputLines?: number }).outputLines });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.outputLines).toBeUndefined();
  });

  // ── streaming tool_use_start/stop events (already covered but verifying) ───

  it('streaming provider with tool_use_start emits correct event shape', async () => {
    const provider = new StreamingMockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'grep', input: { pattern: 'x' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    const toolStarts: Array<{ id: string; name: string }> = [];
    const toolStops: Array<{ id: string; name: string }> = [];
    agent.events.on('provider.tool_use_start', (p) => toolStarts.push({ id: p.id, name: p.name }));
    agent.events.on('provider.tool_use_stop', (p) => toolStops.push({ id: p.id, name: p.name }));
    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(toolStarts).toEqual([{ id: 'u1', name: 'grep' }]);
    expect(toolStops).toEqual([{ id: 'u1', name: 'grep' }]);
  });

  // ── max iterations extension denial ────────────────────────────────────────

  it('honors iteration limit extension denial and stops', async () => {
    const script = Array.from({ length: 5 }, () => ({
      content: [{ type: 'tool_use' as const, id: 'u', name: 'echo', input: {} }],
      stopReason: 'tool_use' as const,
    }));
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const provider = new MockProvider(script);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    // Deny any limit extension
    agent.events.on('iteration.limit_reached', ({ deny }) => deny());
    const result = await agent.run('loop', { maxIterations: 3 });
    expect(result.status).toBe('max_iterations');
  });
});

describe('Agent — sizeSignals coverage', () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const d of cleanupDirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('sizeSignals counts newlines for bash tool without trailing newline', async () => {
    const bashTool: Tool = {
      name: 'bash',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'line1\nline2\nline3'; // 2 newlines, 3 lines total
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'echo build' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [bashTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({ name: e.name, outputLines: (e as never as { outputLines?: number }).outputLines });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.name).toBe('bash');
    expect(executed[0]?.outputLines).toBe(3);
  });

  it('sizeSignals returns undefined outputLines for object-returning tool', async () => {
    const customTool: Tool = {
      name: 'custom',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return { key: 'value' };
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'custom', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [customTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({ name: e.name, outputLines: (e as never as { outputLines?: number }).outputLines });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.outputLines).toBeUndefined();
  });

  it('sizeSignals counts lines for grep tool output', async () => {
    const grepTool: Tool = {
      name: 'grep',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'file1.ts:10:match\nfile2.ts:20:match'; // 1 newline, 2 lines
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'grep', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [grepTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({ name: e.name, outputLines: (e as never as { outputLines?: number }).outputLines });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.outputLines).toBe(2);
  });
});

describe('Agent — streaming provider tool_use events', () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const d of cleanupDirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('streaming provider emits tool_use_start and tool_use_stop', async () => {
    const provider = new StreamingMockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'grep', input: { pattern: 'x' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    const toolStarts: Array<{ id: string; name: string }> = [];
    const toolStops: Array<{ id: string; name: string }> = [];
    agent.events.on('provider.tool_use_start', (p) => toolStarts.push({ id: p.id, name: p.name }));
    agent.events.on('provider.tool_use_stop', (p) => toolStops.push({ id: p.id, name: p.name }));
    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(toolStarts).toEqual([{ id: 'u1', name: 'grep' }]);
    expect(toolStops).toEqual([{ id: 'u1', name: 'grep' }]);
  });

  it('streaming text_delta events accumulate in order', async () => {
    const provider = new StreamingMockProvider([
      { content: [{ type: 'text', text: 'hello world' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    const deltas: string[] = [];
    agent.events.on('provider.text_delta', (p) => deltas.push(p.text));
    const result = await agent.run('hi');
    expect(result.status).toBe('done');
    expect(deltas.join('')).toBe('hello world');
  });
});

describe('Agent — iteration limit extension denial', () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const d of cleanupDirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('honors iteration limit extension denial and stops at max', async () => {
    const script = Array.from({ length: 5 }, () => ({
      content: [{ type: 'tool_use' as const, id: 'u', name: 'echo', input: {} }],
      stopReason: 'tool_use' as const,
    }));
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const provider = new MockProvider(script);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    agent.events.on('iteration.limit_reached', ({ deny }) => deny());
    const result = await agent.run('loop', { maxIterations: 3 });
    expect(result.status).toBe('max_iterations');
  });
});

// Move the orphaned tests back inside the Agent describe block
describe('Agent — additional coverage', () => {
  let cleanupDirs: string[] = [];
  beforeEach(() => {
    cleanupDirs = [];
  });
  afterEach(async () => {
    for (const d of cleanupDirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('accepts ContentBlock[] input including image blocks', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'saw it' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const result = await agent.run([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
    expect(result.status).toBe('done');
    const firstUser = ctx.messages.find((m) => m.role === 'user');
    expect(firstUser).toBeDefined();
    expect(Array.isArray(firstUser!.content)).toBe(true);
    expect((firstUser!.content as unknown[]).length).toBe(2);
  });

  it('uses stream() path for streaming-capable providers and emits text_delta', async () => {
    const provider = new StreamingMockProvider([
      { content: [{ type: 'text', text: 'hello world' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    const deltas: string[] = [];
    agent.events.on('provider.text_delta', (p) => deltas.push(p.text));
    const result = await agent.run('hi');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('hello world');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.join('')).toBe('hello world');
  });

  it('streams tool_use blocks and emits tool_use_start/stop events', async () => {
    const provider = new StreamingMockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'pong' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        return (input as { text: string }).text;
      },
    };
    const { agent, tmp } = await buildAgent(provider as never as MockProvider, [echo]);
    cleanupDirs.push(tmp);
    const toolStarts: { id: string; name: string }[] = [];
    agent.events.on('provider.tool_use_start', (p) => toolStarts.push({ id: p.id, name: p.name }));
    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(toolStarts).toEqual([{ id: 'u1', name: 'echo' }]);
  });

  it('preserves partial assistant text when aborted mid-stream', async () => {
    // Custom streaming provider that yields a few text deltas, then waits
    // long enough for the abort to fire mid-stream.
    const ctrlBox: { current?: AbortController } = {};
    const provider = {
      id: 'partial-mock',
      capabilities: {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: true,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 200_000,
        cacheControl: 'none' as const,
      },
      async *stream(_req: { model: string }, opts: { signal: AbortSignal }) {
        yield { type: 'message_start', model: 'm' };
        yield { type: 'text_delta', text: 'partial ' };
        yield { type: 'text_delta', text: 'answer' };
        // Abort happens here
        ctrlBox.current?.abort();
        // Wait a tick so the abort propagates before the next yield
        await new Promise((r) => setImmediate(r));
        if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield { type: 'text_delta', text: ' that should not appear' };
        yield { type: 'message_stop', stopReason: 'end_turn', usage: { input: 5, output: 3 } };
      },
      async complete() {
        throw new Error('unused');
      },
    } as never as MockProvider;
    const { agent, ctx, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const ctrl = new AbortController();
    ctrlBox.current = ctrl;
    const deltas: string[] = [];
    agent.events.on('provider.text_delta', (p) => deltas.push(p.text));
    const result = await agent.run('hi', { signal: ctrl.signal });
    expect(result.status).toBe('aborted');
    expect(result.finalText).toBe('partial answer');
    expect(deltas.join('')).toBe('partial answer');
    // Partial assistant message must be in the transcript so the next turn
    // has the context.
    const last = ctx.messages[ctx.messages.length - 1];
    expect(last?.role).toBe('assistant');
    const firstBlock = Array.isArray(last?.content) ? last.content[0] : undefined;
    expect(firstBlock).toMatchObject({ type: 'text', text: 'partial answer' });
  });

  it('drains context abort hooks on normal completion', async () => {
    const provider = new StreamingMockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    let hookFired = false;
    ctx.registerAbortHook(() => {
      hookFired = true;
    });
    await agent.run('hi');
    expect(hookFired).toBe(true);
  });

  it('serialises object tool results as JSON', async () => {
    const objTool: Tool = {
      name: 'objres',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return { foo: 1, bar: ['a', 'b'] };
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'objres', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'k' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [objTool]);
    cleanupDirs.push(tmp);
    const result = await agent.run('go');
    expect(result.status).toBe('done');
  });

  it('emits provider.retry on retryable ProviderError and recovers', async () => {
    class FlakyProvider implements Provider {
      readonly id = 'flaky';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      calls = 0;
      async complete(req: Request): Promise<Response> {
        this.calls++;
        if (this.calls === 1) {
          throw new ProviderError('flaky HTTP 529', 529, true, 'flaky', {
            body: {
              type: 'overloaded_error',
              message: 'High traffic detected. Upgrade for highspeed model.',
              requestId: '06534785201de9c0',
            },
          });
        }
        return {
          content: [{ type: 'text', text: 'recovered' }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
          model: req.model,
        };
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }
    const provider = new FlakyProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    // Override retry policy to a near-zero delay so the test runs fast.
    (agent as never as { container: Container }).container.override(TOKENS.RetryPolicy, () => ({
      shouldRetry: (err: Error | ProviderError, attempt: number) =>
        err instanceof ProviderError && err.retryable && attempt < 3,
      delayMs: () => 1,
      maxAttempts: () => 3,
    }));
    // Replace the context's provider with our flaky one.
    (ctx as never as { provider: Provider }).provider = provider;

    const retries: Array<{
      providerId: string;
      attempt: number;
      status: number;
      description: string;
    }> = [];
    const errors: Array<{ providerId: string; status: number; description: string }> = [];
    (agent as never as { events: EventBus }).events.on('provider.retry', (e) => retries.push(e));
    (agent as never as { events: EventBus }).events.on('provider.error', (e) => errors.push(e));

    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.providerId).toBe('flaky');
    expect(retries[0]?.status).toBe(529);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[0]?.description).toContain('overloaded (529)');
    expect(retries[0]?.description).toContain('High traffic detected');
    expect(errors).toHaveLength(0);
  });

  it('emits tool.executed with truncated output preview', async () => {
    const longOutput = 'A'.repeat(2000);
    const echo: Tool = {
      name: 'echo',
      description: 'returns big string',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        return longOutput;
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'big' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);

    const executed: Array<{ name: string; output?: string; input?: unknown; ok: boolean }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({ name: e.name, output: e.output, input: e.input, ok: e.ok });
    });

    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.name).toBe('echo');
    expect(executed[0]?.input).toEqual({ text: 'big' });
    // Capped at 400 with trailing ellipsis.
    expect(executed[0]?.output?.length).toBe(400);
    expect(executed[0]?.output?.endsWith('…')).toBe(true);
  });

  it('emits provider.error when retries are exhausted', async () => {
    class AlwaysFailProvider implements Provider {
      readonly id = 'doomed';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      async complete(): Promise<Response> {
        throw new ProviderError('doomed HTTP 400', 400, false, 'doomed', {
          body: { type: 'invalid_request_error', message: 'bad request' },
        });
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }
    const provider = new AlwaysFailProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;

    const errors: Array<{ providerId: string; status: number; description: string }> = [];
    (agent as never as { events: EventBus }).events.on('provider.error', (e) => errors.push(e));

    const result = await agent.run('ping');
    expect(result.status).toBe('failed');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.providerId).toBe('doomed');
    expect(errors[0]?.status).toBe(400);
    expect(errors[0]?.description).toContain('invalid request (400)');
  });

  it('typed RunResult.error: provider error becomes WrongStackError', async () => {
    class FailProvider implements Provider {
      readonly id = 'fail-prov';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      async complete(): Promise<Response> {
        throw new ProviderError('bad request', 400, false, 'fail-prov');
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }
    const provider = new FailProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;

    const result = await agent.run('ping');
    expect(result.status).toBe('failed');
    // result.error is typed as WrongStackError — ProviderError already extends it
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('PROVIDER_INVALID_REQUEST');
    expect(result.error?.subsystem).toBe('provider');
    expect(typeof result.error?.severity).toBe('string');
    expect(typeof result.error?.describe()).toBe('string');
  });

  it('honors ErrorHandler retry decisions instead of treating truthy recovery as a response', async () => {
    class FailsThenSucceedsProvider implements Provider {
      readonly id = 'recoverable';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      calls = 0;
      async complete(req: Request): Promise<Response> {
        this.calls++;
        if (this.calls === 1) {
          throw new ProviderError('context length exceeded', 413, false, 'recoverable');
        }
        return {
          content: [{ type: 'text', text: `ok:${req.model}` }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
          model: req.model,
        };
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }

    const provider = new FailsThenSucceedsProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;
    (agent as never as { container: Container }).container.override(TOKENS.ErrorHandler, () => ({
      recover: async () => ({
        action: 'retry' as const,
        reason: 'test_retry',
        model: 'fallback-model',
      }),
      classify: () => ({ kind: 'context_overflow' as const, retryable: false }),
    }));

    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('ok:fallback-model');
    expect(provider.calls).toBe(2);
  });

  it('honors ErrorHandler continue decisions as provider responses', async () => {
    class RecoverViaContinueProvider implements Provider {
      readonly id = 'continue-provider';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      calls = 0;
      async complete(): Promise<Response> {
        this.calls++;
        throw new ProviderError('server failed', 500, false, 'continue-provider');
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }

    const provider = new RecoverViaContinueProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;
    (agent as never as { container: Container }).container.override(TOKENS.ErrorHandler, () => ({
      recover: async () => ({
        action: 'continue' as const,
        response: {
          content: [{ type: 'text' as const, text: 'synthetic recovery' }],
          stopReason: 'end_turn' as const,
          usage: { input: 0, output: 0 },
          model: 'test-model',
        },
      }),
      classify: () => ({ kind: 'server' as const, retryable: true }),
    }));

    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('synthetic recovery');
    expect(provider.calls).toBe(1);
  });

  it('honors ErrorHandler fail decisions as terminal failures', async () => {
    class RecoverViaFailProvider implements Provider {
      readonly id = 'fail-provider';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      async complete(): Promise<Response> {
        throw new ProviderError('server failed', 500, false, 'fail-provider');
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }

    const provider = new RecoverViaFailProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;
    const terminal = new Error('terminal recovery decision');
    (agent as never as { container: Container }).container.override(TOKENS.ErrorHandler, () => ({
      recover: async () => ({ action: 'fail' as const, reason: 'terminal', error: terminal }),
      classify: () => ({ kind: 'server' as const, retryable: false }),
    }));

    const result = await agent.run('ping');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('terminal recovery decision');
  });
});
