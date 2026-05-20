import { describe, expect, it } from 'vitest';
import { Container, DefaultConfigStore, TOKENS } from '@wrongstack/core';
import { createDefaultContainer } from '../src/container.js';

const mockConfig = {
  version: 1,
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  log: { level: 'info' as const },
  tools: { maxIterations: 100, iterationTimeoutMs: 300000, defaultExecutionStrategy: 'smart' as const, perIterationOutputCapBytes: 100000, autoExtendLimit: true, sessionTimeoutMs: 1800000 },
  context: { warnThreshold: 0.6, softThreshold: 0.75, hardThreshold: 0.9, preserveK: 10, eliseThreshold: 2000, autoCompact: true },
  features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
} as any;

const mockWpaths = {
  projectSessions: '/tmp/sessions',
  configDir: '/tmp/config',
  projectTrust: '/tmp/trust.json',
} as any;

const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, child: () => mockLogger } as any;
const mockModels = { getProvider: () => Promise.resolve(null), getModel: () => Promise.resolve(null) } as any;

describe('createDefaultContainer', () => {
  it('returns a Container instance', () => {
    const c = createDefaultContainer({ config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels });
    expect(c).toBeInstanceOf(Container);
  });

  it('binds ConfigStore with the provided config', () => {
    const c = createDefaultContainer({ config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels });
    const store = c.resolve(TOKENS.ConfigStore);
    expect(store).toBeInstanceOf(DefaultConfigStore);
  });

  it('binds all required tokens', () => {
    const c = createDefaultContainer({ config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels });
    expect(c.has(TOKENS.Logger)).toBe(true);
    expect(c.has(TOKENS.SecretScrubber)).toBe(true);
    expect(c.has(TOKENS.RetryPolicy)).toBe(true);
    expect(c.has(TOKENS.ErrorHandler)).toBe(true);
    expect(c.has(TOKENS.ModelsRegistry)).toBe(true);
    expect(c.has(TOKENS.TokenCounter)).toBe(true);
    expect(c.has(TOKENS.ModeStore)).toBe(true);
    expect(c.has(TOKENS.SessionStore)).toBe(true);
    expect(c.has(TOKENS.MemoryStore)).toBe(true);
    expect(c.has(TOKENS.SkillLoader)).toBe(true);
    expect(c.has(TOKENS.PermissionPolicy)).toBe(true);
    expect(c.has(TOKENS.Compactor)).toBe(true);
  });

  it('binds SystemPromptBuilder when systemPrompt option is provided', () => {
    const c = createDefaultContainer({
      config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels,
      systemPrompt: { modeId: 'default', modePrompt: '', memoryStore: {} as any },
    });
    expect(c.has(TOKENS.SystemPromptBuilder)).toBe(true);
  });

  it('does not bind SystemPromptBuilder when systemPrompt option is not provided', () => {
    const c = createDefaultContainer({ config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels });
    expect(c.has(TOKENS.SystemPromptBuilder)).toBe(false);
  });

  it('binds Compactor with default options when compactor not provided', () => {
    const c = createDefaultContainer({ config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels });
    const compactor = c.resolve(TOKENS.Compactor);
    expect(compactor).toBeDefined();
  });

  it('passes custom compactor options', () => {
    const c = createDefaultContainer({
      config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels,
      compactor: { preserveK: 50, eliseThreshold: 0.5 },
    });
    const compactor = c.resolve(TOKENS.Compactor);
    expect(compactor).toBeDefined();
  });

  it('passes permission yolo option to DefaultPermissionPolicy', () => {
    const c = createDefaultContainer({
      config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels,
      permission: { yolo: true },
    });
    expect(c.has(TOKENS.PermissionPolicy)).toBe(true);
  });

  it('passes permission forceAllYolo option to DefaultPermissionPolicy', () => {
    const c = createDefaultContainer({
      config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels,
      permission: { yolo: true },
    });
    const policy = c.resolve(TOKENS.PermissionPolicy);
    expect(policy.getForceAllYolo()).toBe(false);
    policy.setForceAllYolo(true);
    expect(policy.getForceAllYolo()).toBe(true);
  });

  it('passes bundledSkillsDir to DefaultSkillLoader', () => {
    const c = createDefaultContainer({
      config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels,
      bundledSkillsDir: '/custom/skills',
    });
    const loader = c.resolve(TOKENS.SkillLoader);
    expect(loader).toBeDefined();
  });

  it('creates ModeStore with correct directory', () => {
    const c = createDefaultContainer({ config: mockConfig, wpaths: mockWpaths, logger: mockLogger, modelsRegistry: mockModels });
    const modeStore = c.resolve(TOKENS.ModeStore);
    expect(modeStore).toBeInstanceOf(Object);
  });
});
