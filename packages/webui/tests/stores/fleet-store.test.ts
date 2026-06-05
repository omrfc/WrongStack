import { beforeEach, describe, expect, it } from 'vitest';
import { useFleetStore } from '../../src/stores';

const fleet = () => useFleetStore.getState();
const get = (id: string) => fleet().agents.get(id);

describe('useFleetStore reducer', () => {
  beforeEach(() => fleet().clear());

  it('creates an agent on spawned with nickname + model', () => {
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Von Neumann',
      provider: 'anthropic',
      model: 'claude-x',
      description: 'analyze',
    });
    const a = get('a1')!;
    expect(a.name).toBe('Von Neumann');
    expect(a.model).toBe('claude-x');
    expect(a.status).toBe('running');
  });

  it('falls back to the id when no name has arrived yet', () => {
    // tool_executed before spawned — agent is materialized from the id.
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a2', toolName: 'bash' });
    const a = get('a2')!;
    expect(a.name).toBe('a2');
    expect(a.toolCalls).toBe(1);
    expect(a.lastTool).toBe('bash');
  });

  it('live-increments tool calls, then iteration_summary corrects to the authoritative count', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a3', name: 'Ada' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a3', toolName: 'read' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a3', toolName: 'grep' });
    expect(get('a3')!.toolCalls).toBe(2);
    fleet().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'a3',
      iteration: 25,
      toolCalls: 47,
      costUsd: 0.02,
      currentTool: 'edit',
    });
    const a = get('a3')!;
    expect(a.toolCalls).toBe(47); // authoritative overwrite
    expect(a.iteration).toBe(25);
    expect(a.costUsd).toBeCloseTo(0.02);
    expect(a.currentTool).toBe('edit');
  });

  it('clamps ctx load to 0–100 percent', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a4', name: 'Grace' });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'a4',
      load: 0.732,
      tokens: 73_200,
      maxContext: 100_000,
    });
    expect(get('a4')!.ctxPct).toBe(73);
    fleet().applyEvent({ kind: 'ctx_pct', subagentId: 'a4', load: 1.5 });
    expect(get('a4')!.ctxPct).toBe(100);
  });

  it('tracks self-extensions', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a5', name: 'Alan' });
    fleet().applyEvent({ kind: 'budget_extended', subagentId: 'a5', totalExtensions: 3 });
    expect(get('a5')!.extensions).toBe(3);
  });

  it('maps task_completed status (success → completed) and clears the current tool', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a6', name: 'Edsger' });
    fleet().applyEvent({ kind: 'iteration_summary', subagentId: 'a6', currentTool: 'bash' });
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a6',
      status: 'success',
      iterations: 12,
      toolCalls: 30,
    });
    const a = get('a6')!;
    expect(a.status).toBe('completed');
    expect(a.iteration).toBe(12);
    expect(a.currentTool).toBeUndefined();
    expect(a.completedAt).toBeTypeOf('number');
  });

  it('preserves a failure envelope on the agent', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a7', name: 'Linus' });
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a7',
      status: 'failed',
      error: { kind: 'rate_limit', message: '429' },
    });
    const a = get('a7')!;
    expect(a.status).toBe('failed');
    expect(a.error).toEqual({ kind: 'rate_limit', message: '429' });
  });

  it('clear() empties the roster', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a8', name: 'x' });
    expect(fleet().agents.size).toBe(1);
    fleet().clear();
    expect(fleet().agents.size).toBe(0);
  });
});
