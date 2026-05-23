import { describe, expect, it, vi } from 'vitest';
import { buildAgentsCommand } from '../src/slash-commands/spawn-agents.js';

function ctx() {
  return {} as never;
}

describe('buildAgentsCommand', () => {
  it('reports multi-agent not enabled when onAgents missing', async () => {
    const cmd = buildAgentsCommand({} as never);
    const res = await cmd.run('', ctx());
    expect(res?.message).toContain('Multi-agent is not enabled');
  });

  it('/agents without id calls onAgents(undefined)', async () => {
    const onAgents = vi.fn().mockReturnValue('all agents summary');
    const cmd = buildAgentsCommand({ onAgents } as never);
    const res = await cmd.run('', ctx());
    expect(onAgents).toHaveBeenCalledWith(undefined);
    expect(res?.message).toBe('all agents summary');
  });

  it('/agents with id calls onAgents(subagentId)', async () => {
    const onAgents = vi.fn().mockReturnValue('Agent ab123\n  status: running');
    const cmd = buildAgentsCommand({ onAgents } as never);
    const res = await cmd.run('ab12345678', ctx());
    expect(onAgents).toHaveBeenCalledWith('ab12345678');
    expect(res?.message).toBe('Agent ab123\n  status: running');
  });

  it('/agents trims whitespace from id', async () => {
    const onAgents = vi.fn().mockReturnValue('ok');
    const cmd = buildAgentsCommand({ onAgents } as never);
    await cmd.run('  sub-1  ', ctx());
    expect(onAgents).toHaveBeenCalledWith('sub-1');
  });

  it('/agents with empty-ish id calls onAgents(undefined)', async () => {
    const onAgents = vi.fn().mockReturnValue('summary');
    const cmd = buildAgentsCommand({ onAgents } as never);
    const res = await cmd.run('   ', ctx());
    expect(onAgents).toHaveBeenCalledWith(undefined);
    expect(res?.message).toBe('summary');
  });
});