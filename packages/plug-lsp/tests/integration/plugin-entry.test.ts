import { describe, expect, it } from 'vitest';
import { Container, EventBus, type Logger, type PluginAPI, type SlashCommand, type Tool } from '@wrongstack/core';
import plugin from '../../src/index.js';
import { PLUGIN_NAME } from '../../src/config.js';

const log: Logger = {
  level: 'error',
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return this;
  },
};

describe('plugin entry', () => {
  it('registers and unregisters tools and slash commands', async () => {
    const tools = new Map<string, Tool>();
    const commands = new Map<string, SlashCommand>();
    const api = {
      container: new Container(),
      events: new EventBus(),
      pipelines: {},
      tools: {
        register: (tool: Tool) => tools.set(tool.name, tool),
        unregister: (name: string) => {
          tools.delete(name);
        },
        get: (name: string) => tools.get(name),
        list: () => Array.from(tools.values()),
      },
      providers: {},
      mcp: {},
      slashCommands: {
        register: (cmd: SlashCommand) => commands.set(`${PLUGIN_NAME}:${cmd.name}`, cmd),
        unregister: (name: string) => commands.delete(name),
        get: (name: string) => commands.get(name),
        list: () => Array.from(commands.values()),
      },
      config: {
        version: 1,
        cwd: process.cwd(),
        extensions: { [PLUGIN_NAME]: { autoDiscover: false, servers: {} } },
      },
      log,
    } as unknown as PluginAPI;

    await plugin.setup(api);
    expect(tools.size).toBe(7);
    expect(commands.size).toBe(5);
    expect(tools.has('lsp_diagnostics')).toBe(true);
    expect(commands.has(`${PLUGIN_NAME}:list`)).toBe(true);

    await plugin.teardown?.(api);
    expect(tools.size).toBe(0);
    expect(commands.size).toBe(0);
  });
});
