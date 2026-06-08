import { describe, expect, it, vi, beforeEach } from 'vitest';
import costTrackerPlugin from '../src/cost-tracker';

const makeApi = () => ({
  tools: { register: vi.fn() },
  config: {
    extensions: {
      'cost-tracker': {},
    },
  },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: {
    counter: vi.fn(),
    histogram: vi.fn(),
    gauge: vi.fn(),
  },
  onEvent: vi.fn(),
  session: { append: vi.fn().mockResolvedValue(undefined) },
});

beforeEach(() => vi.clearAllMocks());

// ── Plugin registration ──────────────────────────────────────────────────────────

describe('cost-tracker plugin', () => {
  it('registers cost_summary, cost_reset, and cost_export tools', () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);
    const names = api.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(names).toContain('cost_summary');
    expect(names).toContain('cost_reset');
    expect(names).toContain('cost_export');
  });

  it('logs info on setup', () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);
    expect(api.log.info).toHaveBeenCalledWith(
      'cost-tracker plugin loaded',
      expect.any(Object),
    );
  });

  it('subscribes to provider.response and session.ended events', () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);
    expect(api.onEvent).toHaveBeenCalledWith(
      'provider.response',
      expect.any(Function),
    );
    expect(api.onEvent).toHaveBeenCalledWith(
      'session.ended',
      expect.any(Function),
    );
  });
});

// ── cost_summary ────────────────────────────────────────────────────────────────

describe('cost_summary tool', () => {
  function getSummaryTool(api: ReturnType<typeof makeApi>) {
    costTrackerPlugin.setup(api as any);
    return api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0] as any;
  }

  it('returns zero totals when no requests tracked', async () => {
    const api = makeApi();
    const tool = getSummaryTool(api);
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.usage.totalRequests).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
    expect(result.usage.totalCostUsd).toBe(0);
    expect(result.budgetStatus).toBe(null);
  });

  it('returns budget status when budgetLimit is configured', async () => {
    const api = makeApi();
    api.config.extensions['cost-tracker'] = { budgetLimit: 10, warningThreshold: 80 };
    const tool = getSummaryTool(api);
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.budgetStatus).toEqual({
      limit: 10,
      spent: 0,
      percentUsed: 0,
      warning: false,
    });
  });
});

// ── cost_reset ─────────────────────────────────────────────────────────────────

describe('cost_reset tool', () => {
  function getResetTool(api: ReturnType<typeof makeApi>) {
    costTrackerPlugin.setup(api as any);
    return api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_reset',
    )?.[0] as any;
  }

  it('returns zero previousTotals when nothing was tracked', async () => {
    const api = makeApi();
    const tool = getResetTool(api);
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.previousTotals.totalTokens).toBe(0);
    expect(result.previousTotals.totalCostUsd).toBe(0);
    expect(result.message).toBe('Cost tracking counters have been reset.');
  });
});

// ── cost_export ────────────────────────────────────────────────────────────────

describe('cost_export tool', () => {
  function getExportTool(api: ReturnType<typeof makeApi>) {
    costTrackerPlugin.setup(api as any);
    return api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_export',
    )?.[0] as any;
  }

  it('returns empty JSON when no requests tracked', async () => {
    const api = makeApi();
    const tool = getExportTool(api);
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.format).toBe('json');
    expect(result.data.summary.totalRequests).toBe(0);
    expect(result.data.summary.totalTokens).toBe(0);
  });

  it('exports as CSV when format=csv', async () => {
    const api = makeApi();
    const tool = getExportTool(api);
    const result = await tool.execute({ format: 'csv' });
    expect(result.ok).toBe(true);
    expect(result.format).toBe('csv');
    expect(result.data).toContain('model,timestamp');
  });

  it('omits model column from CSV when includeModel=false', async () => {
    const api = makeApi();
    const tool = getExportTool(api);
    const result = await tool.execute({ format: 'csv', includeModel: false });
    expect(result.ok).toBe(true);
    expect(result.data).not.toContain('model,');
    expect(result.data).toContain('timestamp,');
  });

  it('omits model field from JSON when includeModel=false', async () => {
    const api = makeApi();
    const tool = getExportTool(api);
    const result = await tool.execute({ format: 'json', includeModel: false });
    expect(result.ok).toBe(true);
    expect(result.data.requests).toEqual([]);
  });
});

// ── Event: provider.response ─────────────────────────────────────────────────────

describe('provider.response event handler', () => {
  it('tracks token usage from provider.response event', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    // Find and fire the provider.response handler
    const responseCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'provider.response',
    );
    const handler = responseCall?.[1] as Function;
    expect(handler).toBeDefined();

    handler({
      usage: { input: 1000, output: 500 },
      ctx: { model: 'gpt-4o' },
    });

    // Now check cost_summary
    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0] as any;
    const result = await summaryTool.execute({});
    expect(result.usage.totalPromptTokens).toBe(1000);
    expect(result.usage.totalCompletionTokens).toBe(500);
    expect(result.usage.totalTokens).toBe(1500);
    expect(result.usage.totalCostUsd).toBeGreaterThan(0);
    expect(result.usage.byModel['gpt-4o']).toBeDefined();
    expect(result.usage.byModel['gpt-4o'].requests).toBe(1);
  });

  it('aggregates costs per model across multiple requests', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const responseCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'provider.response',
    ) as any[];
    const handler = responseCall[1] as Function;

    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'claude-3-5-sonnet' } });
    handler({ usage: { input: 2000, output: 1000 }, ctx: { model: 'claude-3-5-sonnet' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0] as any;
    const result = await summaryTool.execute({});
    expect(result.usage.totalRequests).toBe(2);
    expect(result.usage.byModel['claude-3-5-sonnet'].requests).toBe(2);
  });

  it('records recentRequests (last 5)', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const responseCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'provider.response',
    ) as any[];
    const handler = responseCall[1] as Function;

    for (let i = 0; i < 8; i++) {
      handler({ usage: { input: 100, output: 50 }, ctx: { model: 'gpt-4o-mini' } });
    }

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0] as any;
    const result = await summaryTool.execute({});
    expect(result.usage.totalRequests).toBe(8);
    expect(result.usage.recentRequests.length).toBeLessThanOrEqual(5);
  });
});

// ── Event: session.ended ───────────────────────────────────────────────────────

describe('session.ended event handler', () => {
  it('writes session summary when requests were tracked', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const responseCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'provider.response',
    ) as any[];
    responseCall[1]({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });

    const endedCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'session.ended',
    ) as any[];
    await endedCall[1](); // fire session.ended

    expect(api.session.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cost-tracker:session_summary',
        totalTokens: 1500,
        totalRequests: 1,
      }),
    );
  });

  it('does not write session summary when no requests', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const endedCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'session.ended',
    ) as any[];
    await endedCall[1](); // fire session.ended with no requests

    expect(api.session.append).not.toHaveBeenCalled();
  });
});
