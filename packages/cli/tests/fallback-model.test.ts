import { type Config, EventBus, type Provider, ProviderError } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { createFallbackModelExtension, parseModelRef } from '../src/fallback-model.js';

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function fakeProvider(id: string): Provider {
  return { id, capabilities: {} as never, complete: vi.fn(), stream: vi.fn() } as Provider;
}

function makeCtx(providerId: string, model: string) {
  return { provider: fakeProvider(providerId), model } as never;
}

function overload(providerId: string) {
  return new ProviderError('overloaded', 529, true, providerId);
}

function cfg(over: Partial<Config>): Config {
  return { provider: 'anthropic', model: 'opus', fallbackModels: [], ...over } as unknown as Config;
}

describe('parseModelRef', () => {
  it('parses bare, slash, and space forms', () => {
    expect(parseModelRef('haiku')).toEqual({ model: 'haiku' });
    expect(parseModelRef('openai/gpt-x')).toEqual({ provider: 'openai', model: 'gpt-x' });
    expect(parseModelRef('openai gpt-x')).toEqual({ provider: 'openai', model: 'gpt-x' });
  });

  it('treats a leading-slash entry as "use the primary provider"', () => {
    expect(parseModelRef('/gpt-x')).toEqual({ provider: undefined, model: 'gpt-x' });
  });
});

describe('createFallbackModelExtension', () => {
  it('returns null when no fallbackModels configured', () => {
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: [] }),
      buildProvider: fakeProvider,
      events: new EventBus(),
      logger,
    });
    expect(ext).toBeNull();
  });

  it('walks the chain on overload and succeeds on a fallback (same provider)', async () => {
    const events = new EventBus();
    const fired: unknown[] = [];
    events.on('provider.fallback', (p) => fired.push(p));
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['sonnet', 'haiku'] }),
      buildProvider: fakeProvider,
      events,
      logger,
    })!;

    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async (_c: unknown, _r: unknown) => {
      call++;
      if (call <= 2) throw overload('anthropic'); // primary + first fallback fail
      return { stopReason: 'end_turn', usage: { input: 1, output: 1 } } as never;
    });

    const res = await ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);
    expect(res).toBeTruthy();
    expect(call).toBe(3);
    expect(ctx.model).toBe('haiku');
    expect(fired).toHaveLength(2);
  });

  it('switches provider for a cross-provider entry', async () => {
    const events = new EventBus();
    const fired: { providerSwitched: boolean }[] = [];
    events.on('provider.fallback', (p) => fired.push(p as never));
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['openai/gpt-x'] }),
      buildProvider: fakeProvider,
      events,
      logger,
    })!;

    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async () => {
      call++;
      if (call === 1) throw overload('anthropic');
      return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
    });

    await ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);
    expect(ctx.provider.id).toBe('openai');
    expect(ctx.model).toBe('gpt-x');
    expect(fired[0]?.providerSwitched).toBe(true);
  });

  it('does not fall back on a non-overload error', async () => {
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['haiku'] }),
      buildProvider: fakeProvider,
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    const boom = new ProviderError('bad request', 400, false, 'anthropic');
    const inner = vi.fn(async () => {
      throw boom;
    });
    await expect(
      ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never),
    ).rejects.toBe(boom);
    expect(inner).toHaveBeenCalledTimes(1); // no chain walk
  });

  it('skips an entry whose provider cannot be built, continues the chain', async () => {
    const buildProvider = vi.fn((id: string) => {
      if (id === 'broken') throw new Error('no creds');
      return fakeProvider(id);
    });
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['broken/x', 'haiku'] }),
      buildProvider,
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async () => {
      call++;
      if (call === 1) throw overload('anthropic');
      return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
    });
    await ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);
    expect(ctx.model).toBe('haiku');
  });

  it('notifies onModelSwitch on fallback hop and on primary restore', async () => {
    const switches: Array<[string, string]> = [];
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['openai/gpt-x'] }),
      buildProvider: fakeProvider,
      onModelSwitch: (p, m) => switches.push([p, m]),
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    await ext.wrapProviderRunner!(
      ctx,
      { model: 'opus' } as never,
      (async () => {
        call++;
        if (call === 1) throw overload('anthropic');
        return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
      }) as never,
    );
    expect(switches).toContainEqual(['openai', 'gpt-x']); // fallback hop
    await ext.beforeRun!(ctx, {} as never);
    expect(switches).toContainEqual(['anthropic', 'opus']); // primary restore
  });

  it('restores the primary at the start of the next turn (beforeRun)', async () => {
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['haiku'] }),
      buildProvider: fakeProvider,
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    // Force a fallback so ctx lands on haiku.
    let call = 0;
    await ext.wrapProviderRunner!(
      ctx,
      { model: 'opus' } as never,
      (async () => {
        call++;
        if (call === 1) throw overload('anthropic');
        return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
      }) as never,
    );
    expect(ctx.model).toBe('haiku');
    // Next turn: beforeRun resets to the configured primary.
    await ext.beforeRun!(ctx, {} as never);
    expect(ctx.model).toBe('opus');
    expect(ctx.provider.id).toBe('anthropic');
  });
});
