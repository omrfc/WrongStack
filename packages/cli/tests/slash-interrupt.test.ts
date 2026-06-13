import { stripAnsi } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildInterruptCommand } from '../src/slash-commands/interrupt.js';

function makeCtx(over: Partial<SlashCommandContext> = {}) {
  return {
    interruptController: { abortLeader: vi.fn(() => false) },
    onFleetKill: vi.fn(() => 0),
    ...over,
  } as unknown as SlashCommandContext;
}

describe('/interrupt', () => {
  it('aborts the leader and kills the fleet, reporting both', async () => {
    const abortLeader = vi.fn(() => true);
    const onFleetKill = vi.fn(() => 3);
    const ctx = makeCtx({ interruptController: { abortLeader }, onFleetKill });
    const res = await buildInterruptCommand(ctx).run('');
    expect(abortLeader).toHaveBeenCalledTimes(1);
    expect(onFleetKill).toHaveBeenCalledTimes(1);
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('Interrupted');
    expect(msg).toContain('leader run');
    expect(msg).toContain('3 subagents');
  });

  it('kills the fleet even when no leader run was active', async () => {
    const abortLeader = vi.fn(() => false);
    const onFleetKill = vi.fn(() => 1);
    const ctx = makeCtx({ interruptController: { abortLeader }, onFleetKill });
    const res = await buildInterruptCommand(ctx).run('');
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('1 subagent');
    expect(msg).not.toContain('subagents');
  });

  it('reports nothing to interrupt when idle', async () => {
    const ctx = makeCtx();
    const res = await buildInterruptCommand(ctx).run('');
    expect(stripAnsi(res?.message ?? '')).toContain('Nothing to interrupt');
  });

  it('"all" behaves the same as no-arg', async () => {
    const abortLeader = vi.fn(() => true);
    const onFleetKill = vi.fn(() => 0);
    const ctx = makeCtx({ interruptController: { abortLeader }, onFleetKill });
    const res = await buildInterruptCommand(ctx).run('all');
    expect(abortLeader).toHaveBeenCalledTimes(1);
    expect(stripAnsi(res?.message ?? '')).toContain('leader run');
  });

  it('is registered with /stop and /int aliases', () => {
    const cmd = buildInterruptCommand(makeCtx());
    expect(cmd.name).toBe('interrupt');
    expect(cmd.aliases).toEqual(['stop', 'int']);
  });

  it('tolerates a missing interruptController (default no-op)', async () => {
    const onFleetKill = vi.fn(() => 0);
    const ctx = { onFleetKill } as unknown as SlashCommandContext;
    const res = await buildInterruptCommand(ctx).run('');
    expect(stripAnsi(res?.message ?? '')).toContain('Nothing to interrupt');
  });
});
