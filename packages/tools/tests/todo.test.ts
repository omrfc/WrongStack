import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todoTool } from '../src/todo.js';
import { type Sandbox, mkSandbox, newSignal } from './fixtures.js';

describe('todo tool', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('replaces todo list', async () => {
    const out = await todoTool.execute(
      {
        todos: [
          { id: '1', content: 'a', status: 'pending' },
          { id: '2', content: 'b', status: 'in_progress' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.count).toBe(2);
    expect(out.in_progress).toBe(1);
  });

  it('enforces single in_progress', async () => {
    const out = await todoTool.execute(
      {
        todos: [
          { id: '1', content: 'a', status: 'in_progress' },
          { id: '2', content: 'b', status: 'in_progress' },
          { id: '3', content: 'c', status: 'in_progress' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.in_progress).toBe(1);
  });
});
