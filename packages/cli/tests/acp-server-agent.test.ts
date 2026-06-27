/**
 * Tests for the ACP server → real Agent factory.
 *
 * Covers the two paths that matter for `wstack acp`:
 *  1. No provider configured → AcpServerConfigError with an actionable message.
 *  2. Provider configured → agentFor() builds a real, isolated Agent per session.
 *
 * setupProvider is mocked so the happy path doesn't hit models.dev or need a
 * live API key; the provider it returns is a stub whose `complete`/`stream`
 * throw if actually called — the factory only needs the Provider type slot
 * filled to construct Context + Agent.
 */

import type {
  Config,
  Provider,
  ProviderRegistry,
  ResolvedProvider,
  WstackPaths,
} from '@wrongstack/core';
import { Agent, ToolRegistry as RealToolRegistry } from '@wrongstack/core';
import { builtinToolsPack } from '@wrongstack/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock setupProvider so we control provider/registry construction without
// touching models.dev or network.
const mockSetupProvider = vi.fn();
vi.mock('../src/wiring/provider.js', () => ({
  setupProvider: (...args: unknown[]) => mockSetupProvider(...args),
}));

// createDefaultContainer binds a lot of stateful services; mock it so the test
// stays fast and hermetic. The factory resolves TOKENS.Logger (needs .child)
// and TOKENS.SecretScrubber from it during Agent construction.
vi.mock('@wrongstack/runtime', () => ({
  createDefaultContainer: () => ({
    resolve: () => ({
      child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      scrub: (s: string) => s,
    }),
  }),
}));

import { AcpServerConfigError, buildAcpServerAgentFactory } from '../src/acp-server-agent.js';
import type { RunTurnApi } from '@wrongstack/acp/agent';
import type { SubcommandDeps } from '../src/subcommands/index.js';

function makeStubProvider(): Provider {
  return {
    id: 'test',
    capabilities: { maxContext: 0 },
    complete: async () => {
      throw new Error('stub provider: complete not implemented');
    },
    stream: () => {
      throw new Error('stub provider: stream not implemented');
    },
  } as never as Provider;
}

function makeDeps(overrides: Partial<SubcommandDeps> = {}): SubcommandDeps {
  const tools = new RealToolRegistry();
  tools.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  return {
    config: {
      provider: 'test-provider',
      model: 'test-model',
      features: {},
      tools: {},
    } as never as Config,
    renderer: {
      write: vi.fn(),
      writeError: vi.fn(),
      writeWarning: vi.fn(),
      writeInfo: vi.fn(),
      projectRoot: '/tmp',
    } as never,
    reader: { readLine: vi.fn(), readKey: vi.fn(), readSecret: vi.fn(), close: vi.fn() } as never,
    paths: {} as WstackPaths,
    vault: { encrypt: vi.fn((s: string) => s), decrypt: vi.fn((s: string) => s) } as never,
    modelsRegistry: {} as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    userHome: '/tmp',
    toolRegistry: tools,
    flags: {},
    ...overrides,
  };
}

describe('buildAcpServerAgentFactory', () => {
  beforeEach(() => {
    mockSetupProvider.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws AcpServerConfigError when no provider is configured', () => {
    const deps = makeDeps({
      config: { provider: undefined, model: undefined } as never as Config,
    });
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(AcpServerConfigError);
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(/wstack auth/);
  });

  it('throws AcpServerConfigError when provider is set but model is missing', () => {
    const deps = makeDeps({
      config: { provider: 'anthropic', model: undefined } as never as Config,
    });
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(AcpServerConfigError);
  });

  it('builds a real, isolated Agent per session when a provider is configured', async () => {
    const provider = makeStubProvider();
    const providerRegistry = { has: () => true } as never as ProviderRegistry;
    mockSetupProvider.mockResolvedValue({
      provider,
      providerRegistry,
      resolvedProvider: {} as ResolvedProvider,
    });

    const deps = makeDeps();
    const agentFor = buildAcpServerAgentFactory(deps);

    const a1 = await agentFor('sess-1', '/tmp');
    const a2 = await agentFor('sess-2', '/tmp');

    expect(a1).toBeInstanceOf(Agent);
    expect(a2).toBeInstanceOf(Agent);
    // Sessions are isolated: each gets its own event bus / context.
    expect(a1).not.toBe(a2);
    expect(a1.events).not.toBe(a2.events);
    expect(a1.ctx).not.toBe(a2.ctx);
    // The configured model flows through to the context.
    expect(a1.ctx.model).toBe('test-model');
  });

  it('wires ACP-backed fs/terminal tools when the client advertises capabilities', async () => {
    const provider = makeStubProvider();
    const providerRegistry = { has: () => true } as never as ProviderRegistry;
    mockSetupProvider.mockResolvedValue({
      provider,
      providerRegistry,
      resolvedProvider: {} as ResolvedProvider,
    });

    const reads: Array<{ path: string }> = [];
    const writes: Array<{ path: string; content: string }> = [];
    const terminals: Array<{ command: string; args?: string[] }> = [];
    const api: RunTurnApi = {
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      requestPermission: async () => ({ outcome: 'selected', optionId: 'allow_once' }),
      readTextFile: async (p) => {
        reads.push({ path: p.path });
        return 'line one\nline two';
      },
      writeTextFile: async (p) => {
        writes.push(p);
      },
      runTerminal: async (p) => {
        terminals.push({ command: p.command, ...(p.args ? { args: p.args } : {}) });
        return { output: 'terminal output', exitCode: 0 };
      },
    };

    const agentFor = buildAcpServerAgentFactory(makeDeps());
    const agent = await agentFor('sess-acp', '/tmp', api);

    const readTool = agent.tools.get('read');
    const readOut = (await readTool!.execute({ path: 'a.ts' }, agent.ctx)) as { text: string };
    expect(reads[0]).toMatchObject({ path: 'a.ts' });
    expect(readOut.text).toContain('line one');

    const writeTool = agent.tools.get('write');
    await writeTool!.execute({ path: 'b.ts', content: 'hello' }, agent.ctx);
    expect(writes[0]).toMatchObject({ path: 'b.ts', content: 'hello' });

    const bashTool = agent.tools.get('bash');
    const bashOut = (await bashTool!.execute({ command: 'echo hi' }, agent.ctx)) as {
      stdout: string;
      exit_code: number | null;
    };
    expect(terminals[0]?.command).toBe('sh');
    expect(bashOut.stdout).toBe('terminal output');
    expect(bashOut.exit_code).toBe(0);
  });

  it('keeps local builtin tools when the client advertises no fs/terminal', async () => {
    const provider = makeStubProvider();
    mockSetupProvider.mockResolvedValue({
      provider,
      providerRegistry: { has: () => true } as never as ProviderRegistry,
      resolvedProvider: {} as ResolvedProvider,
    });
    const api: RunTurnApi = {
      clientCapabilities: {},
      requestPermission: async () => ({ outcome: 'cancelled' }),
      readTextFile: async () => '',
      writeTextFile: async () => {},
      runTerminal: async () => ({ output: '', exitCode: 0 }),
    };
    const agent = await buildAcpServerAgentFactory(makeDeps())('s', '/tmp', api);
    // The builtin read tool is still the local one (its capabilities include fs.read).
    expect(agent.tools.get('read')?.capabilities).toContain('fs.read');
  });

  it('memoizes the provider boot so repeated sessions reuse one setup call', async () => {
    const provider = makeStubProvider();
    const providerRegistry = { has: () => true } as never as ProviderRegistry;
    mockSetupProvider.mockResolvedValue({
      provider,
      providerRegistry,
      resolvedProvider: {} as ResolvedProvider,
    });

    const agentFor = buildAcpServerAgentFactory(makeDeps());
    await agentFor('sess-a', '/tmp');
    await agentFor('sess-b', '/tmp');
    await agentFor('sess-c', '/tmp');

    expect(mockSetupProvider).toHaveBeenCalledTimes(1);
  });
});
