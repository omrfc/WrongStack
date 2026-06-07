import { describe, expect, it, vi, beforeEach } from 'vitest';
import costTrackerPlugin from '../src/cost-tracker';

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
  onEvent: vi.fn(() => () => {}),
  session: { append: vi.fn().mockResolvedValue(undefined), transcriptPath: undefined },
};

describe('cost-tracker plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports a default Plugin object', () => {
    expect(costTrackerPlugin).toBeDefined();
    expect(typeof costTrackerPlugin).toBe('object');
  });

  it('plugin has correct name', () => {
    expect(costTrackerPlugin.name).toBe('cost-tracker');
  });

  it('plugin has correct apiVersion', () => {
    expect(costTrackerPlugin.apiVersion).toMatch(/^\^?0\.1/);
  });

  it('registers cost_summary tool', () => {
    costTrackerPlugin.setup(mockApi as any);
    const toolNames = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(toolNames).toContain('cost_summary');
  });

  it('cost_summary tool has empty inputSchema', () => {
    costTrackerPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary'
    )?.[0];

    expect(tool).toBeDefined();
    expect(tool?.name).toBe('cost_summary');
    expect(tool?.permission).toBe('auto');
    expect(tool?.mutating).toBe(false);
    const schema = tool?.inputSchema as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties).length).toBe(0);
    expect(schema.required ?? []).toEqual([]);
  });

  it('marks cost_reset as mutating', () => {
    costTrackerPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_reset'
    )?.[0];

    expect(tool).toBeDefined();
    expect(tool?.mutating).toBe(true);
  });

  it('subscribes to the typed session.ended lifecycle event', () => {
    costTrackerPlugin.setup(mockApi as any);

    expect(mockApi.onEvent).toHaveBeenCalledWith('session.ended', expect.any(Function));
  });

  it('setup does not throw', () => {
    expect(() => costTrackerPlugin.setup(mockApi as any)).not.toThrow();
  });
});
