import { describe, expect, it, vi } from 'vitest';
import { buildCoordinatorCommand } from '../src/slash-commands/coordinator.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeCommand(overrides: Partial<SlashCommandContext> = {}) {
  return buildCoordinatorCommand(overrides as SlashCommandContext);
}

describe('/coordinator slash command', () => {
  it('requires a goal for start', async () => {
    const onCoordinatorStart = vi.fn();
    const command = makeCommand({ onCoordinatorStart });

    const result = await command.run('start   ');

    expect(onCoordinatorStart).not.toHaveBeenCalled();
    expect(result.message).toContain('A goal is required');
  });

  it('passes the full goal text to onCoordinatorStart', async () => {
    const onCoordinatorStart = vi.fn();
    const command = makeCommand({ onCoordinatorStart });

    const result = await command.run('start audit and fix auth security issues');

    expect(onCoordinatorStart).toHaveBeenCalledOnce();
    expect(onCoordinatorStart).toHaveBeenCalledWith('audit and fix auth security issues');
    expect(result.message).toContain('AutonomousCoordinator started');
  });

  it('calls onCoordinatorStop for stop', async () => {
    const onCoordinatorStop = vi.fn();
    const command = makeCommand({ onCoordinatorStop });

    const result = await command.run('stop');

    expect(onCoordinatorStop).toHaveBeenCalledOnce();
    expect(result.message).toContain('stop signal sent');
  });

  it('reports whether start and stop hooks are wired', async () => {
    const command = makeCommand({ onCoordinatorStart: vi.fn(), onCoordinatorStop: vi.fn() });

    const result = await command.run('status');

    expect(result.message).toContain('start=yes');
    expect(result.message).toContain('stop=yes');
  });

  it('lists pending tasks from onCoordinatorTasks', async () => {
    const onCoordinatorTasks = vi.fn(async () => [
      { id: 'task-1234', title: 'Audit secrets', priority: 'critical', tags: ['security'] },
      { id: 'task-5678', title: 'Add tests', priority: 'medium', tags: [] },
    ]);
    const command = makeCommand({ onCoordinatorTasks });

    const result = await command.run('tasks');

    expect(onCoordinatorTasks).toHaveBeenCalledOnce();
    expect(result.message).toContain('task-1234');
    expect(result.message).toContain('Audit secrets');
    expect(result.message).toContain('Add tests');
    expect(result.message).toContain('/coordinator claim');
  });

  it('rejects claim without an id', async () => {
    const onCoordinatorClaim = vi.fn(async () => null);
    const command = makeCommand({ onCoordinatorClaim });

    const result = await command.run('claim   ');

    expect(onCoordinatorClaim).not.toHaveBeenCalled();
    expect(result.message).toContain('Usage');
  });

  it('matches a task by id prefix and claims it', async () => {
    const onCoordinatorTasks = vi.fn(async () => [
      { id: 'task-abcdef', title: 'Fix typo', priority: 'low', tags: ['docs'] },
    ]);
    const onCoordinatorClaim = vi.fn(async (id: string) => {
      expect(id).toBe('task-abcdef');
      return { description: 'Fix the typo in README' };
    });
    const command = makeCommand({ onCoordinatorTasks, onCoordinatorClaim });

    const result = await command.run('claim task-abc');

    expect(onCoordinatorClaim).toHaveBeenCalledOnce();
    expect(result.message).toContain('Claimed task');
    expect(result.runText).toContain('Fix the typo in README');
  });

  it('marks a task as done via onCoordinatorComplete', async () => {
    const onCoordinatorComplete = vi.fn(async (id: string, note?: string) => {
      expect(id).toBe('task-xyz');
      expect(note).toBe('All good');
      return null;
    });
    const command = makeCommand({ onCoordinatorComplete });

    const result = await command.run('done task-xyz All good');

    expect(onCoordinatorComplete).toHaveBeenCalledOnce();
    expect(result.message).toContain('marked completed');
  });

  it('marks a task as failed via onCoordinatorFail', async () => {
    const onCoordinatorFail = vi.fn(async (id: string, reason: string) => {
      expect(id).toBe('task-bad');
      expect(reason).toBe('tests broke');
      return null;
    });
    const command = makeCommand({ onCoordinatorFail });

    const result = await command.run('fail task-bad tests broke');

    expect(onCoordinatorFail).toHaveBeenCalledOnce();
    expect(result.message).toContain('marked failed');
  });

  it('shows real stats via onCoordinatorStatus', async () => {
    const onCoordinatorStatus = vi.fn(async () => ({
      goals: { total: 5, done: 2, pending: 2, failed: 1 },
      dag: { running: 1, ready: 1, done: 2, failed: 1 },
      auction: { pending: 2, inProgress: 1 },
    }));
    const command = makeCommand({ onCoordinatorStatus });

    const result = await command.run('status');

    expect(onCoordinatorStatus).toHaveBeenCalledOnce();
    expect(result.message).toContain('5 total');
    expect(result.message).toContain('2 done');
    expect(result.message).toContain('1 running');
    expect(result.message).toContain('Use /coordinator tasks');
  });

  it('reports no coordinator active when status returns null', async () => {
    const onCoordinatorStatus = vi.fn(async () => null);
    const command = makeCommand({ onCoordinatorStatus });

    const result = await command.run('status');

    expect(result.message).toContain('No coordinator is active');
  });

  it('reports when no task matches the prefix', async () => {
    const onCoordinatorTasks = vi.fn(async () => [
      { id: 'task-abcdef', title: 'Fix typo', priority: 'low', tags: ['docs'] },
    ]);
    const onCoordinatorClaim = vi.fn(async () => null);
    const command = makeCommand({ onCoordinatorTasks, onCoordinatorClaim });

    const result = await command.run('claim nope');

    expect(onCoordinatorClaim).not.toHaveBeenCalled();
    expect(result.message).toContain('No pending coordinator task matched');
  });
});
