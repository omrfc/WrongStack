import type { Context } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { buildCompactCommand } from '../src/slash-commands/compact.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

const makeCtx = (
  compactor?: SlashCommandContext['compactor'],
): SlashCommandContext => {
  const write = vi.fn();
  const writeInfo = vi.fn();
  const writeWarning = vi.fn();
  return {
    compactor,
    renderer: { write, writeInfo, writeWarning } as never,
  } as never as SlashCommandContext;
};

const fakeContext = {} as Context;

const baseReport = {
  before: 100_000,
  after: 60_000,
  fullRequestTokensBefore: 100_000,
  fullRequestTokensAfter: 60_000,
  reductions: [
    { phase: 'elision' as const, saved: 25_000 },
    { phase: 'selective' as const, saved: 15_000 },
  ],
};

describe('/compact slash command', () => {
  it('exposes metadata', () => {
    const cmd = buildCompactCommand(makeCtx());
    expect(cmd.name).toBe('compact');
    expect(cmd.help).toContain('/compact aggressive');
  });

  it('warns when no compactor is configured', async () => {
    const ctx = makeCtx();
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', fakeContext);
    expect(result!.message).toBe('No compactor configured.');
    expect(ctx.renderer.writeWarning).toHaveBeenCalledWith('No compactor configured.');
  });

  it('calls compactor with aggressive:false by default', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    await cmd.run!('', fakeContext);
    expect(compact).toHaveBeenCalledWith(fakeContext, { aggressive: false });
  });

  it('passes aggressive:true when args trim to "aggressive"', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    await cmd.run!('  aggressive  ', fakeContext);
    expect(compact).toHaveBeenCalledWith(fakeContext, { aggressive: true });
  });

  it('renders before/after token totals and per-phase reductions', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', fakeContext);
    expect(result!.message).toContain('100000 -> 60000 tokens');
    expect(result!.message).toContain('elision: 25000');
    expect(result!.message).toContain('selective: 15000');
  });

  it('includes repair counts when the report has a repaired field', async () => {
    const compact = vi.fn(async () => ({
      ...baseReport,
      repaired: {
        removedToolUses: ['t1', 't2'],
        removedToolResults: ['r1'],
        removedMessages: 3,
      },
    }) as typeof baseReport & { repaired: { removedToolUses: string[]; removedToolResults: string[]; removedMessages: number } });
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', fakeContext);
    expect(result!.message).toContain('repaired 2 tool_use');
    expect(result!.message).toContain('1 tool_result');
    expect(result!.message).toContain('3 empty messages');
  });

  it('omits repair section when the field is absent', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', fakeContext);
    expect(result!.message).not.toMatch(/repaired/);
  });

  it('writes the summary line to the renderer info channel', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    await cmd.run!('', fakeContext);
    expect(ctx.renderer.writeInfo).toHaveBeenCalledTimes(1);
  });
});
