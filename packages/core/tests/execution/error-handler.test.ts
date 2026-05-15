import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { buildRecoveryStrategies } from '../../src/execution/error-handler.js';
import { DefaultErrorHandler, ProviderError } from '../../src/index.js';
import type { Compactor } from '../../src/types/compactor.js';
import type { ModelsRegistry } from '../../src/types/models-registry.js';

const provErr = (msg: string, status: number) => new ProviderError(msg, status, false, 'test');

describe('DefaultErrorHandler.classify', () => {
  const eh = new DefaultErrorHandler();

  it('classifies 429 as rate_limit (retryable)', () => {
    expect(eh.classify(provErr('rate limited', 429))).toEqual({
      kind: 'rate_limit',
      retryable: true,
    });
  });

  it('classifies 529 as overloaded (retryable)', () => {
    expect(eh.classify(provErr('overloaded', 529))).toEqual({
      kind: 'overloaded',
      retryable: true,
    });
  });

  it('classifies 500 as server (retryable)', () => {
    const c = eh.classify(provErr('boom', 500));
    expect(c.kind).toBe('server');
    expect(c.retryable).toBe(true);
  });

  it('classifies 413 as context_overflow (not retryable)', () => {
    expect(eh.classify(provErr('payload too large', 413))).toEqual({
      kind: 'context_overflow',
      retryable: false,
    });
  });

  it('classifies 400 with "context" in message as context_overflow', () => {
    expect(eh.classify(provErr('context length exceeded', 400)).kind).toBe('context_overflow');
  });

  it('classifies generic 4xx as client (not retryable)', () => {
    expect(eh.classify(provErr('bad', 404))).toEqual({
      kind: 'client',
      retryable: false,
    });
  });

  it('classifies AbortError as abort', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(eh.classify(err)).toEqual({ kind: 'abort', retryable: false });
  });

  it('classifies fetch failures as network', () => {
    expect(eh.classify(new Error('fetch failed: ECONNRESET'))).toEqual({
      kind: 'network',
      retryable: true,
    });
  });

  it('classifies unknown errors', () => {
    expect(eh.classify(new Error('?'))).toEqual({ kind: 'unknown', retryable: false });
  });

  it('recover returns null by default', async () => {
    const res = await eh.recover(new Error('x'), {} as never);
    expect(res).toBeNull();
  });
});

describe('recovery strategies', () => {
  function makeCtx(overrides: Partial<Context> = {}): Context {
    return {
      model: 'gpt-4',
      provider: { id: 'openai' } as never,
      messages: [],
      ...overrides,
    } as Context;
  }

  it('context_overflow strategy compacts on 413 and asks the agent to retry', async () => {
    const compactor: Compactor = {
      compact: vi.fn(async () => ({
        before: 10_000,
        after: 3_000,
        reductions: [{ phase: 'system', saved: 7000 }],
      })),
    } as unknown as Compactor;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ compactor }));
    const res = await eh.recover(provErr('payload too big', 413), makeCtx());
    expect(res).toEqual({ action: 'retry', reason: 'context_compacted' });
    expect(compactor.compact).toHaveBeenCalled();
  });

  it('context_overflow returns null when compactor failed to shrink anything', async () => {
    const compactor: Compactor = {
      compact: vi.fn(async () => ({
        before: 10_000,
        after: 10_000,
        reductions: [],
      })),
    } as unknown as Compactor;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ compactor }));
    const res = await eh.recover(provErr('payload too big', 413), makeCtx());
    expect(res).toBeNull();
  });

  it('context_overflow swallows compactor throws', async () => {
    const compactor: Compactor = {
      compact: vi.fn(async () => {
        throw new Error('compaction failed');
      }),
    } as unknown as Compactor;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ compactor }));
    const res = await eh.recover(provErr('payload too big', 413), makeCtx());
    expect(res).toBeNull();
  });

  it('rate_limit_backoff waits then asks the agent to retry', { timeout: 10_000 }, async () => {
    const eh = new DefaultErrorHandler(buildRecoveryStrategies());
    const err = new ProviderError('rate limited', 429, true, 'test', {
      body: { retryAfterMs: 1100 },
    });
    const start = Date.now();
    const res = await eh.recover(err, makeCtx());
    const elapsed = Date.now() - start;
    expect(res).toEqual({ action: 'retry', reason: 'rate_limit_backoff' });
    expect(elapsed).toBeGreaterThanOrEqual(1000);
  });

  it('rate_limit_backoff clamps suggested wait to 1s minimum', { timeout: 10_000 }, async () => {
    const eh = new DefaultErrorHandler(buildRecoveryStrategies());
    const err = new ProviderError('slow down', 429, true, 'test', { body: { retryAfterMs: 10 } });
    const start = Date.now();
    await eh.recover(err, makeCtx());
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
  });

  it('downgrade_model picks cheapest compatible fallback on 500', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        family: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
          { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
          { id: 'gpt-3.7', cost: { input: 5 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async (_p: string, m: string) => ({
        id: m,
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as unknown as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    const res = await eh.recover(provErr('server', 503), makeCtx());
    expect(res).toEqual({
      action: 'retry',
      reason: 'model_downgrade',
      model: 'gpt-3.5',
    });
  });

  it('downgrade_model returns null when no cheaper model exists', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async () => ({
        id: 'gpt-4',
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as unknown as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    expect(await eh.recover(provErr('server', 500), makeCtx())).toBeNull();
  });

  it('downgrade_model returns null when provider not in registry', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => undefined),
      getModel: vi.fn(async () => undefined),
    } as unknown as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    expect(await eh.recover(provErr('server', 500), makeCtx())).toBeNull();
  });

  it('downgrade_model swallows registry throws', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => {
        throw new Error('catalog gone');
      }),
      getModel: vi.fn(),
    } as unknown as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    expect(await eh.recover(provErr('server', 500), makeCtx())).toBeNull();
  });

  it('downgrade_model requires vision when original required it', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        models: [
          {
            id: 'gpt-4-vision',
            cost: { input: 30 },
            tool_call: true,
            modalities: { input: ['text', 'image'] },
          },
          { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async () => ({
        id: 'gpt-4-vision',
        cost: { input: 30 },
        capabilities: { tools: true, vision: true },
      })),
    } as unknown as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    const res = await eh.recover(provErr('server', 500), makeCtx());
    // gpt-3.5 lacks image input, so no candidates.
    expect(res).toBeNull();
  });
});
