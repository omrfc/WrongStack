import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { buildFallbackCommand } from '../src/slash-commands/fallback.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeCtx(initial: Record<string, unknown> = {}) {
  const wsDir = mkdtempSync(path.join(tmpdir(), 'wstack-fallback-'));
  const globalConfig = path.join(wsDir, 'config.json');
  const seed = { provider: 'anthropic', model: 'opus', providers: {}, ...initial };
  writeFileSync(globalConfig, JSON.stringify(seed, null, 2));
  let live: Record<string, unknown> = { ...seed };
  const update = vi.fn((patch: Record<string, unknown>) => {
    live = { ...live, ...patch };
  });
  const ctx = {
    configStore: { get: vi.fn(() => live), update },
    paths: { globalConfig },
  } as unknown as SlashCommandContext;
  const readFile = () => JSON.parse(readFileSync(globalConfig, 'utf8')) as Record<string, unknown>;
  return { ctx, update, readFile, getLive: () => live };
}

describe('/fallback', () => {
  it('shows the current chain and auto state with no args', async () => {
    const { ctx } = makeCtx({ fallbackModels: ['openai/gpt-4o'] });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('');
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('Fallback chain');
    expect(msg).toContain('openai/gpt-4o');
    expect(msg).toContain('auto');
  });

  it('add appends a model to the explicit chain and persists', async () => {
    const { ctx, update, readFile } = makeCtx();
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('add openai/gpt-4o');
    expect(stripAnsi(res?.message ?? '')).toContain('added');
    expect(readFile().fallbackModels).toEqual(['openai/gpt-4o']);
    expect(update).toHaveBeenCalledWith({ fallbackModels: ['openai/gpt-4o'] });
  });

  it('add rejects a duplicate', async () => {
    const { ctx, readFile } = makeCtx({ fallbackModels: ['openai/gpt-4o'] });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('add openai/gpt-4o');
    expect(stripAnsi(res?.message ?? '')).toContain('Already in chain');
    expect(readFile().fallbackModels).toEqual(['openai/gpt-4o']);
  });

  it('remove by 1-based index drops the right entry', async () => {
    const { ctx, readFile } = makeCtx({ fallbackModels: ['a/1', 'b/2', 'c/3'] });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('remove 2');
    expect(stripAnsi(res?.message ?? '')).toContain('removed');
    expect(readFile().fallbackModels).toEqual(['a/1', 'c/3']);
  });

  it('remove by exact reference works', async () => {
    const { ctx, readFile } = makeCtx({ fallbackModels: ['a/1', 'b/2'] });
    const cmd = buildFallbackCommand(ctx);
    await cmd.run('remove b/2');
    expect(readFile().fallbackModels).toEqual(['a/1']);
  });

  it('clear empties the explicit chain', async () => {
    const { ctx, readFile } = makeCtx({ fallbackModels: ['a/1'] });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('clear');
    expect(stripAnsi(res?.message ?? '')).toContain('cleared');
    expect(readFile().fallbackModels).toEqual([]);
  });

  it('auto off persists fallbackAuto=false', async () => {
    const { ctx, update, readFile } = makeCtx();
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('auto off');
    expect(stripAnsi(res?.message ?? '')).toContain('off');
    expect(readFile().fallbackAuto).toBe(false);
    expect(update).toHaveBeenCalledWith({ fallbackAuto: false });
  });

  it('rejects an unknown subcommand', async () => {
    const { ctx } = makeCtx();
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('frobnicate');
    expect(stripAnsi(res?.message ?? '')).toContain('Unknown subcommand');
  });
});
