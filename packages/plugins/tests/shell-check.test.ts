import { describe, expect, it, vi, beforeEach } from 'vitest';
import shellCheckPlugin from '../src/shell-check';

const mockApi = {
  tools: {
    register: vi.fn()
  },
  config: { extensions: {} },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
  pipelines: {
    response: { use: vi.fn(), get: vi.fn() },
  },
};

describe('shell-check plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports a default Plugin object', () => {
    expect(shellCheckPlugin).toBeDefined();
    expect(typeof shellCheckPlugin).toBe('object');
  });

  it('plugin has correct name', () => {
    expect(shellCheckPlugin.name).toBe('shell-check');
  });

  it('plugin has correct apiVersion', () => {
    expect(shellCheckPlugin.apiVersion).toMatch(/^\^?0\.1/);
  });

  it('registers shellcheck tool', () => {
    shellCheckPlugin.setup(mockApi as any);
    const toolNames = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(toolNames).toContain('shellcheck');
  });

  it('registers shellcheck_scan tool', () => {
    shellCheckPlugin.setup(mockApi as any);
    const toolNames = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(toolNames).toContain('shellcheck_scan');
  });

  it('shellcheck tool has correct schema', () => {
    shellCheckPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls
      .map(([t]: any[]) => t as any)
      .find((t: any) => t.name === 'shellcheck');

    expect(tool).toBeDefined();
    expect(tool?.name).toBe('shellcheck');
    expect(tool?.permission).toBe('auto');
    // shellcheck has observable side effects (spawns processes / network), so it
    // is declared mutating to trip the permission confirmation gate. See
    // permission-policy `tool.permission === 'auto' && !tool.mutating`.
    expect(tool?.mutating).toBe(true);
  });

  it('setup does not throw', () => {
    expect(() => shellCheckPlugin.setup(mockApi as any)).not.toThrow();
  });
});