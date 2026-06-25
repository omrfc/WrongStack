import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DefaultConfigStore,
  ToolRegistry,
  type Config,
  type Context,
  type Tool,
} from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildToolCommand } from '../src/slash-commands/tool.js';

let tmp: string;

const fullDescription =
  'Read a file from disk and return its contents with optional line ranges. Use this for inspecting source code, configuration files, documentation, and generated output before making edits.';

const baseConfig: Config = {
  version: 1,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  context: {
    warnThreshold: 0.6,
    softThreshold: 0.75,
    hardThreshold: 0.9,
    preserveK: 10,
    eliseThreshold: 2000,
  },
  tools: {
    defaultExecutionStrategy: 'smart',
    maxIterations: 100,
    iterationTimeoutMs: 300_000,
    sessionTimeoutMs: 1_800_000,
    perIterationOutputCapBytes: 100_000,
    descriptionMode: {},
  },
  log: { level: 'info' },
  features: {
    mcp: true,
    plugins: true,
    memory: true,
    modelsRegistry: true,
    skills: true,
  },
};

function makeTool(): Tool {
  return {
    name: 'read',
    description: fullDescription,
    usageHint: `${fullDescription} Prefer narrow line ranges.`,
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    async execute() {
      return '';
    },
  };
}

function makeCommand() {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(makeTool(), '@wrongstack/tools');
  const configStore = new DefaultConfigStore(baseConfig);
  const globalConfig = path.join(tmp, 'config.json');
  const command = buildToolCommand({
    toolRegistry,
    configStore,
    paths: {
      globalConfig,
      inProjectConfig: path.join(tmp, 'project', '.wrongstack', 'config.json'),
    },
  } as never);
  return { command, toolRegistry, configStore, globalConfig };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-tool-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('buildToolCommand', () => {
  it('persists and applies a simple tool description mode', async () => {
    const { command, toolRegistry, configStore, globalConfig } = makeCommand();

    const res = await command.run('read simple', {} as Context);

    expect(res?.message).toContain('read');
    expect(configStore.get().tools.descriptionMode?.read).toBe('simple');
    expect(toolRegistry.getDescriptionMode('read')).toBe('simple');
    expect(toolRegistry.get('read')?.description.length).toBeLessThan(fullDescription.length);

    const saved = JSON.parse(await fs.readFile(globalConfig, 'utf8')) as Config;
    expect(saved.tools.descriptionMode?.read).toBe('simple');
    expect(saved.tools.maxIterations).toBe(100);
  });

  it('extend removes the override and restores the full description', async () => {
    const { command, toolRegistry, configStore, globalConfig } = makeCommand();

    await command.run('read simple', {} as Context);
    await command.run('read extend', {} as Context);

    expect(configStore.get().tools.descriptionMode?.read).toBeUndefined();
    expect(toolRegistry.getDescriptionMode('read')).toBe('extend');
    expect(toolRegistry.get('read')?.description).toBe(fullDescription);

    const saved = JSON.parse(await fs.readFile(globalConfig, 'utf8')) as Config;
    expect(saved.tools.descriptionMode?.read).toBeUndefined();
    expect(saved.tools.maxIterations).toBe(100);
  });

  it('shows usage for invalid modes', async () => {
    const { command } = makeCommand();

    const res = await command.run('read tiny', {} as Context);

    expect(res?.message).toContain('/tool read simple|extend');
  });
});
