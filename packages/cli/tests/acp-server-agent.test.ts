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
import { Agent } from '@wrongstack/core';
import type { Config, ModelsRegistry, Provider, ProviderRegistry, ResolvedProvider, WstackPaths } from '@wrongstack/core';
import { ToolRegistry as RealToolRegistry } from '@wrongstack/core';
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
  } as unknown as Provider;
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
    } as unknown as Config,
    renderer: {
      write: vi.fn(),
      writeError: vi.fn(),
      writeWarning: vi.fn(),
      writeInfo: vi.fn(),
      projectRoot: '/tmp',
    } as never,
    reader: { readLine: vi.fn(), readKey: vi.fn(), readSecret: vi.fn(), close: vi.fn() } as never,
    modelsRegistry: { providers: {}, customModels: {} } as unknown as ModelsRegistry,
    paths: {} as unknown as WstackPaths,
    vault: { encrypt: vi.fn((s: string) => s), decrypt: vi.fn((s: string) => s) } as never,
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
      config: { provider: undefined, model: undefined } as unknown as Config,
    });
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(AcpServerConfigError);
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(/wstack auth/);
  });

  it('throws AcpServerConfigError when provider is set but model is missing', () => {
    const deps = makeDeps({
      config: { provider: 'anthropic', model: undefined } as unknown as Config,
    });
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(AcpServerConfigError);
  });

  it('builds a real, isolated Agent per session when a provider is configured', async () => {
    const provider = makeStubProvider();
    const providerRegistry = { has: () => true } as unknown as ProviderRegistry;
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

  it('memoizes the provider boot so repeated sessions reuse one setup call', async () => {
    const provider = makeStubProvider();
    const providerRegistry = { has: () => true } as unknown as ProviderRegistry;
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
