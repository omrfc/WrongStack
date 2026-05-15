import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../src/app.js';
import { createQueueSlashCommand, handleQueueCommand } from '../src/queue-slash.js';

function makeDeps(initial: QueueItem[] = []) {
  let queue = [...initial];
  const cleared: number[] = [];
  const deleted: number[][] = [];
  return {
    deps: {
      getQueue: () => queue,
      clear: () => {
        cleared.push(queue.length);
        queue = [];
      },
      deleteAt: (positions: number[]) => {
        deleted.push([...positions]);
        const drop = new Set(positions.map((p) => p - 1));
        queue = queue.filter((_, i) => !drop.has(i));
      },
    },
    snapshot: () => ({ queue: [...queue], cleared, deleted }),
  };
}

const item = (id: number, text: string): QueueItem => ({ id, displayText: text, blocks: [] });

describe('handleQueueCommand', () => {
  it('empty queue → list says empty', () => {
    const { deps } = makeDeps();
    expect(handleQueueCommand('', deps)).toBe('Queue is empty.');
    expect(handleQueueCommand('list', deps)).toBe('Queue is empty.');
  });

  it('list renders 1-based numbered items with single-line preview', () => {
    const { deps } = makeDeps([item(1, 'first message'), item(2, 'multi\n\nline\nthing')]);
    const out = handleQueueCommand('list', deps);
    expect(out).toContain('Queue (2):');
    expect(out).toContain('  1. first message');
    expect(out).toContain('  2. multi line thing');
  });

  it('truncates long previews with an ellipsis', () => {
    const big = 'x'.repeat(300);
    const { deps } = makeDeps([item(1, big)]);
    const out = handleQueueCommand('', deps);
    expect(out).toMatch(/x+…/);
    expect(out.length).toBeLessThan(big.length);
  });

  it('clear empties the queue and reports the count', () => {
    const { deps, snapshot } = makeDeps([item(1, 'a'), item(2, 'b')]);
    expect(handleQueueCommand('clear', deps)).toBe('Cleared 2 queued messages.');
    expect(snapshot().queue).toEqual([]);
  });

  it('clear on empty queue is idempotent', () => {
    const { deps } = makeDeps();
    expect(handleQueueCommand('clear', deps)).toBe('Queue is already empty.');
  });

  it('delete by 1-based positions, ignoring duplicates and invalid', () => {
    const { deps, snapshot } = makeDeps([item(1, 'a'), item(2, 'b'), item(3, 'c'), item(4, 'd')]);
    const out = handleQueueCommand('delete 1 3 3 99 abc', deps);
    expect(out).toContain('Deleted 2 of 4');
    expect(out).toContain('positions 1, 3');
    expect(out).toContain('invalid: abc');
    expect(out).toContain('out of range');
    expect(snapshot().queue.map((q) => q.displayText)).toEqual(['b', 'd']);
  });

  it('delete with no positions returns usage', () => {
    const { deps } = makeDeps([item(1, 'a')]);
    expect(handleQueueCommand('delete', deps)).toMatch(/Usage:/);
  });

  it('delete on empty queue refuses', () => {
    const { deps } = makeDeps();
    expect(handleQueueCommand('delete 1', deps)).toBe('Queue is empty — nothing to delete.');
  });

  it('delete with only invalid positions reports without calling deleteAt', () => {
    const { deps, snapshot } = makeDeps([item(1, 'a')]);
    const out = handleQueueCommand('delete 99 abc', deps);
    expect(out).toContain('No valid positions');
    expect(snapshot().deleted).toEqual([]);
    expect(snapshot().queue).toHaveLength(1);
  });

  it('accepts del / rm aliases for delete', () => {
    const { deps, snapshot } = makeDeps([item(1, 'a'), item(2, 'b')]);
    handleQueueCommand('del 1', deps);
    expect(snapshot().queue.map((q) => q.displayText)).toEqual(['b']);
    handleQueueCommand('rm 1', deps);
    expect(snapshot().queue).toEqual([]);
  });

  it('unknown subcommand returns usage', () => {
    const { deps } = makeDeps();
    const out = handleQueueCommand('weird', deps);
    expect(out).toContain('Unknown subcommand');
    expect(out).toContain('Usage:');
  });
});

describe('createQueueSlashCommand', () => {
  it('returns a SlashCommand with name "queue" and routes args through handleQueueCommand', async () => {
    const { deps } = makeDeps([item(1, 'hi')]);
    const cmd = createQueueSlashCommand(deps);
    expect(cmd.name).toBe('queue');
    const res = await cmd.run('list', {} as never);
    expect(res?.message).toContain('1. hi');
  });
});
