import { describe, expect, it, vi, beforeEach } from 'vitest';
import tokenBudgetPlugin from '../src/token-budget';

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  metrics: { counter: ReturnType<typeof vi.fn>; histogram: ReturnType<typeof vi.fn>; gauge: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  session: { append: ReturnType<typeof vi.fn> };
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getResponseHandler(api: MockApi): (payload: unknown) => void {
  const call = api.onEvent.mock.calls.find(([event]: unknown[]) => event === 'provider.response');
  if (!call) throw new Error('provider.response handler not registered');
  return (call as unknown[])[1] as (payload: unknown) => void;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(([t]: unknown[]) => (t as { name: string }).name === 'token_budget_status');
  if (!call) throw new Error('token_budget_status tool not registered');
  return (call[0] as { execute: (input: unknown) => Promise<unknown> });
}

function getStopHook(api: MockApi): (input: unknown) => { decision?: string; reason?: string } | void {
  const call = api.registerHook.mock.calls.find(([event]: unknown[]) => event === 'Stop');
  if (!call) throw new Error('Stop hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getStopHook>;
}

beforeEach(() => vi.clearAllMocks());

describe('token-budget plugin', () => {
  it('registers token_budget_status tool and a Stop hook', () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledTimes(1);
    expect(api.registerHook.mock.calls[0]![0]).toBe('Stop');
  });

  it('subscribes to provider.response events', () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    expect(api.onEvent).toHaveBeenCalledWith('provider.response', expect.any(Function));
  });
});

describe('token accumulation', () => {
  it('accumulates tokens from provider.response events', async () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });
    handler({ usage: { input: 2000, output: 1000 }, ctx: { model: 'gpt-4o' } });
    const status = await getStatusTool(api).execute({});
    expect(status.consumed).toBe(4500);
    expect(status.requestCount).toBe(2);
    expect(status.breakdown.prompt).toBe(3000);
    expect(status.breakdown.completion).toBe(1500);
  });

  it('tracks per-model when configured', async () => {
    const api = makeApi({ extensions: { 'token-budget': { limit: 10000, model: 'gpt-4o' } } });
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });
    handler({ usage: { input: 5000, output: 5000 }, ctx: { model: 'claude-3-5-sonnet' } });
    const result = await getStatusTool(api).execute({});
    expect(result.consumed).toBe(1500);
  });

  it('handles missing usage gracefully', () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    expect(() => handler({ ctx: { model: 'gpt-4o' } })).not.toThrow();
  });
});

describe('warning threshold', () => {
  it('fires one-shot warning when warnPercent is reached', () => {
    const api = makeApi({ extensions: { 'token-budget': { limit: 10000, warnPercent: 80 } } });
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 5000, output: 3000 }, ctx: { model: 'gpt-4o' } });
    expect(api.emitCustom).toHaveBeenCalledWith('token-budget:warning', expect.objectContaining({
      percent: 80,
      total: 8000,
      limit: 10000,
    }));
  });

  it('does not fire warning again (one-shot)', () => {
    const api = makeApi({ extensions: { 'token-budget': { limit: 10000, warnPercent: 80 } } });
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 5000, output: 3000 }, ctx: { model: 'gpt-4o' } });
    handler({ usage: { input: 1000, output: 0 }, ctx: { model: 'gpt-4o' } });
    const warns = api.emitCustom.mock.calls.filter((c: unknown[]) => c[0] === 'token-budget:warning');
    expect(warns).toHaveLength(1);
  });
});

describe('stop threshold', () => {
  it('fires one-shot stop event when stopPercent is reached', () => {
    const api = makeApi({ extensions: { 'token-budget': { limit: 1000, stopPercent: 100 } } });
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 600, output: 400 }, ctx: { model: 'gpt-4o' } });
    expect(api.emitCustom).toHaveBeenCalledWith('token-budget:limit_reached', expect.objectContaining({
      total: 1000,
      limit: 1000,
    }));
  });

  it('Stop hook returns block when budget is exhausted', () => {
    const api = makeApi({ extensions: { 'token-budget': { limit: 1000, stopPercent: 100 } } });
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    const stopHook = getStopHook(api);
    handler({ usage: { input: 600, output: 400 }, ctx: { model: 'gpt-4o' } });
    const result = stopHook({});
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('token-budget');
  });

  it('Stop hook returns void when budget is not exhausted', () => {
    const api = makeApi({ extensions: { 'token-budget': { limit: 10000 } } });
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    const stopHook = getStopHook(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });
    const result = stopHook({});
    expect(result).toBeUndefined();
  });

  it('limit=0 means tracking only (no enforcement)', () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    const stopHook = getStopHook(api);
    for (let i = 0; i < 10; i++) {
      handler({ usage: { input: 100000, output: 50000 }, ctx: { model: 'gpt-4o' } });
    }
    expect(api.emitCustom).not.toHaveBeenCalled();
    expect(stopHook({})).toBeUndefined();
  });
});

describe('token_budget_status tool', () => {
  it('reports zero state before any requests', async () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    const result = await getStatusTool(api).execute({});
    expect(result.consumed).toBe(0);
    expect(result.requestCount).toBe(0);
    expect(result.percent).toBe(0);
    expect(result.warningFired).toBe(false);
    expect(result.stopFired).toBe(false);
  });

  it('reports correct percentage with limit', async () => {
    const api = makeApi({ extensions: { 'token-budget': { limit: 10000 } } });
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 3000, output: 2000 }, ctx: { model: 'gpt-4o' } });
    const result = await getStatusTool(api).execute({});
    expect(result.consumed).toBe(5000);
    expect(result.percent).toBe(50);
    expect(result.remaining).toBe(5000);
  });

  it('reports Infinity remaining when limit=0', async () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });
    const result = await getStatusTool(api).execute({});
    expect(result.remaining).toBe(Infinity);
  });
});

describe('teardown + H1 pattern', () => {
  it('logs completion line and does not throw', () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    expect(() => tokenBudgetPlugin.teardown!(api as never)).not.toThrow();
    expect(api.log.info).toHaveBeenCalledWith('token-budget: teardown complete', expect.any(Object));
  });

  it('zeros counters on teardown', async () => {
    const api = makeApi();
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });
    tokenBudgetPlugin.teardown!(api as never);
    const health = await tokenBudgetPlugin.health!();
    expect(health.totalTokens).toBe(0);
    expect(health.requestCount).toBe(0);
  });

  it('reload cycle: setup → teardown → setup zeros state', async () => {
    const api = makeApi({ extensions: { 'token-budget': { limit: 10000 } } });
    tokenBudgetPlugin.setup(api as never);
    const handler = getResponseHandler(api);
    handler({ usage: { input: 5000, output: 3000 }, ctx: { model: 'gpt-4o' } });
    tokenBudgetPlugin.teardown!(api as never);
    tokenBudgetPlugin.setup(api as never);
    const health = await tokenBudgetPlugin.health!();
    expect(health.totalTokens).toBe(0);
    expect(health.warningFired).toBe(false);
    expect(health.stopFired).toBe(false);
  });

  it('teardown is safe to call before setup (defensive)', () => {
    const api = makeApi();
    expect(() => tokenBudgetPlugin.teardown!(api as never)).not.toThrow();
  });
});
