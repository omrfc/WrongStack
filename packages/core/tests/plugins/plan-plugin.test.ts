import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildPlanCommand } from '../../src/plugins/plan-plugin.js';

let tmp: string;
let planPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-slash-'));
  planPath = path.join(tmp, 'plan.json');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * Fake dispatch context — the plugin reads `ctx.session.id` and
 * `ctx.state.replaceTodos` off the live run context (2nd arg to run()).
 */
function makeCtx() {
  return {
    session: { id: 'sess-x' },
    state: { replaceTodos: vi.fn() },
  } as never;
}

describe('buildPlanCommand', () => {
  it('reports when planPath missing', async () => {
    const cmd = buildPlanCommand(undefined);
    const res = await cmd.run('show', makeCtx());
    expect(res.message).toContain('not configured');
  });

  it('show on empty plan renders empty state', async () => {
    const res = await buildPlanCommand(planPath).run('', makeCtx());
    expect(typeof res.message).toBe('string');
  });

  it('add without args returns usage', async () => {
    const res = await buildPlanCommand(planPath).run('add', makeCtx());
    expect(res.message).toContain('Usage:');
  });

  it('add inserts an item and persists', async () => {
    const res = await buildPlanCommand(planPath).run('add Investigate timeout bug', makeCtx());
    expect(res.message).toContain('Investigate timeout bug');
    const persisted = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(persisted.items).toHaveLength(1);
  });

  it('start without arg returns usage', async () => {
    const res = await buildPlanCommand(planPath).run('start', makeCtx());
    expect(res.message).toContain('Usage:');
  });

  it('start by 1-based index sets in_progress', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run('add One thing', makeCtx());
    await cmd.run('start 1', makeCtx());
    const stored = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(stored.items[0].status).toBe('in_progress');
  });

  it('done by 1-based index sets done', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run('add One thing', makeCtx());
    await cmd.run('done 1', makeCtx());
    const stored = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(stored.items[0].status).toBe('done');
  });

  it('remove without arg returns usage', async () => {
    const res = await buildPlanCommand(planPath).run('rm', makeCtx());
    expect(res.message).toContain('Usage:');
  });

  it('remove drops the item', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run('add A', makeCtx());
    await cmd.run('add B', makeCtx());
    await cmd.run('remove 1', makeCtx());
    const stored = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].title).toBe('B');
  });

  it('promote without args returns usage', async () => {
    expect((await buildPlanCommand(planPath).run('promote', makeCtx())).message).toContain('Usage:');
  });

  it('promote with unmatched id reports no match', async () => {
    const res = await buildPlanCommand(planPath).run('promote 99', makeCtx());
    expect(res.message).toContain('No plan item matched');
  });

  it('promote derives todos and updates ctx', async () => {
    const ctx = makeCtx() as { state: { replaceTodos: ReturnType<typeof vi.fn> } };
    const cmd = buildPlanCommand(planPath);
    await cmd.run('add Build login', ctx as never);
    const res = await cmd.run('promote 1 design ui validate', ctx as never);
    expect(res.message).toContain('Promoted to');
    expect(ctx.state.replaceTodos).toHaveBeenCalled();
  });

  it('derive without arg returns usage', async () => {
    expect((await buildPlanCommand(planPath).run('derive', makeCtx())).message).toContain('Usage:');
  });

  it('derive with unmatched id reports no match', async () => {
    const res = await buildPlanCommand(planPath).run('derive 42', makeCtx());
    expect(res.message).toContain('No plan item matched');
  });

  it('derive on existing item produces todos', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run('add Refactor auth', makeCtx());
    const res = await cmd.run('derive 1', makeCtx());
    expect(res.message).toContain('Derived');
  });

  it('template list returns formatted template list', async () => {
    const cmd = buildPlanCommand(planPath);
    expect(typeof (await cmd.run('template', makeCtx())).message).toBe('string');
    expect(typeof (await cmd.run('template list', makeCtx())).message).toBe('string');
  });

  it('template use without name returns usage', async () => {
    const res = await buildPlanCommand(planPath).run('template use', makeCtx());
    expect(res.message).toContain('Usage:');
  });

  it('template use with unknown name reports error', async () => {
    const res = await buildPlanCommand(planPath).run('template use does-not-exist', makeCtx());
    expect(res.message).toContain('Unknown template');
  });

  it('template unknown sub-verb reports', async () => {
    const res = await buildPlanCommand(planPath).run('template frobulate', makeCtx());
    expect(res.message).toContain('Unknown template subcommand');
  });

  it('clear wipes the plan', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run('add A', makeCtx());
    const res = await cmd.run('clear', makeCtx());
    expect(res.message).toContain('cleared');
    const stored = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(stored.items).toEqual([]);
  });

  it('unknown subcommand reports usage', async () => {
    const res = await buildPlanCommand(planPath).run('frobulate', makeCtx());
    expect(res.message).toContain('Unknown subcommand');
  });

  it('uses unknown session id when context absent', async () => {
    const res = await buildPlanCommand(planPath).run('add stuff', undefined as never);
    expect(typeof res.message).toBe('string');
    const stored = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(stored.sessionId).toBe('unknown');
  });
});
