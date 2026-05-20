import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planTool } from '../src/plan.js';
import { newSignal } from './fixtures.js';

interface PlanSandbox {
  dir: string;
  planPath: string;
  ctx: Context;
  cleanup(): Promise<void>;
}

async function mkPlanSandbox(): Promise<PlanSandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plan-tool-'));
  const planPath = path.join(dir, 'sess.plan.json');
  const ctx = {
    cwd: dir,
    projectRoot: dir,
    session: { id: 'sess', append: async () => undefined, close: async () => undefined },
    meta: { 'plan.path': planPath },
  } as unknown as Context;
  return {
    dir,
    planPath,
    ctx,
    cleanup: async () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describe('planTool', () => {
  let sb: PlanSandbox;
  beforeEach(async () => {
    sb = await mkPlanSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('show on a fresh session returns an empty plan', async () => {
    const out = await planTool.execute({ action: 'show' }, sb.ctx, { signal: newSignal() });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(0);
    expect(out.open).toBe(0);
    expect(out.plan).toContain('empty');
  });

  it('add persists items to disk', async () => {
    await planTool.execute(
      { action: 'add', title: 'audit schema' },
      sb.ctx,
      { signal: newSignal() },
    );
    const raw = JSON.parse(await fs.readFile(sb.planPath, 'utf8')) as {
      items: Array<{ title: string; status: string }>;
    };
    expect(raw.items).toHaveLength(1);
    expect(raw.items[0]?.title).toBe('audit schema');
    expect(raw.items[0]?.status).toBe('open');
  });

  it('start and done transition status', async () => {
    await planTool.execute({ action: 'add', title: 'one' }, sb.ctx, { signal: newSignal() });
    await planTool.execute({ action: 'add', title: 'two' }, sb.ctx, { signal: newSignal() });
    await planTool.execute({ action: 'start', target: '1' }, sb.ctx, { signal: newSignal() });
    const afterStart = JSON.parse(await fs.readFile(sb.planPath, 'utf8')) as {
      items: Array<{ status: string }>;
    };
    expect(afterStart.items[0]?.status).toBe('in_progress');

    const out = await planTool.execute(
      { action: 'done', target: '1' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.open).toBe(1); // item 2 still open
    expect(out.count).toBe(2);
  });

  it('add without title returns ok=false', async () => {
    const out = await planTool.execute({ action: 'add' }, sb.ctx, { signal: newSignal() });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/title/i);
  });

  it('returns failure when plan path is not configured', async () => {
    const noMetaCtx = {
      cwd: sb.dir,
      projectRoot: sb.dir,
      session: { id: 'x', append: async () => undefined, close: async () => undefined },
      meta: {},
    } as unknown as Context;
    const out = await planTool.execute({ action: 'show' }, noMetaCtx, { signal: newSignal() });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/path is not configured/i);
  });

  it('clear empties the plan', async () => {
    await planTool.execute({ action: 'add', title: 'x' }, sb.ctx, { signal: newSignal() });
    const out = await planTool.execute({ action: 'clear' }, sb.ctx, { signal: newSignal() });
    expect(out.count).toBe(0);
    expect(out.open).toBe(0);
  });

  it('template_use applies a template', async () => {
    const out = await planTool.execute(
      { action: 'template_use', template: 'bug-fix' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(true);
    expect(out.count).toBeGreaterThan(0);
    expect(out.message).toContain('bug-fix');

    const raw = JSON.parse(await fs.readFile(sb.planPath, 'utf8')) as {
      items: Array<{ title: string }>;
    };
    expect(raw.items.length).toBeGreaterThan(0);
    expect(raw.items[0]!.title).toBeDefined();
  });

  it('template_use with unknown template returns ok=false', async () => {
    const out = await planTool.execute(
      { action: 'template_use', template: 'nonexistent' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(false);
    expect(out.message).toContain('Unknown template');
  });

  it('promote creates todos and updates plan', async () => {
    // Set up a mock state.replaceTodos
    const replacedTodos: unknown[] = [];
    sb.ctx.state = {
      replaceTodos(todos: unknown[]) {
        replacedTodos.push(...todos);
      },
    } as unknown as Context['state'];

    await planTool.execute({ action: 'add', title: 'Build feature' }, sb.ctx, { signal: newSignal() });
    const out = await planTool.execute(
      { action: 'promote', target: '1', subtasks: ['Write tests', 'Implement'] },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(true);
    expect(out.todos).toBeDefined();
    expect(out.todos!.length).toBe(3); // 1 parent + 2 subtasks
    expect(replacedTodos.length).toBe(3);
  });
});
