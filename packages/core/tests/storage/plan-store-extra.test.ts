import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPlan,
  deriveTodosFromPlanItem,
  formatPlan,
  loadPlan,
  mutatePlan,
  removePlanItem,
  savePlan,
  setPlanItemStatus,
} from '../../src/storage/plan-store.js';
import type { PlanFile } from '../../src/types/plan.js';

const mkPlan = (): PlanFile => ({
  title: 'My plan',
  updatedAt: '2026-01-01T00:00:00.000Z',
  items: [
    { id: 'a', title: 'First', status: 'pending', details: 'line1\nline2' },
    { id: 'b', title: 'Second', status: 'in_progress' },
    { id: 'c', title: 'Third', status: 'done' },
  ],
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plan-extra-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('plan-store — extra coverage', () => {
  it('removePlanItem / setPlanItemStatus return the plan unchanged on no match', () => {
    const plan = mkPlan();
    expect(removePlanItem(plan, 'nope')).toBe(plan);
    expect(setPlanItemStatus(plan, 'nope', 'done')).toBe(plan);
  });

  it('removePlanItem and setPlanItemStatus match by index / id / title substring', () => {
    const plan = mkPlan();
    expect(removePlanItem(plan, '1').items).toHaveLength(2);
    expect(setPlanItemStatus(plan, 'b', 'done').items[1]?.status).toBe('done');
    expect(setPlanItemStatus(plan, 'thir', 'pending').items[2]?.status).toBe('pending');
  });

  it('clearPlan empties items; formatPlan renders title, marks and details', () => {
    expect(clearPlan(mkPlan()).items).toEqual([]);
    expect(formatPlan({ items: [], updatedAt: '' } as PlanFile)).toBe('Plan is empty.');
    const out = formatPlan(mkPlan());
    expect(out).toContain('# My plan');
    expect(out).toContain('1. [ ] First');
    expect(out).toContain('2. [~] Second');
    expect(out).toContain('3. [x] Third');
    expect(out).toContain('     line2');
  });

  it('deriveTodosFromPlanItem returns null on no match', () => {
    expect(deriveTodosFromPlanItem(mkPlan(), 'nomatch')).toBeNull();
  });

  it('deriveTodosFromPlanItem promotes an item plus subtasks and marks it in_progress', () => {
    const result = deriveTodosFromPlanItem(mkPlan(), 'a', ['sub one', 'sub two']);
    expect(result).not.toBeNull();
    expect(result?.plan.items[0]?.status).toBe('in_progress');
    expect(result?.todos).toHaveLength(3);
    expect(result?.todos[0]?.status).toBe('in_progress');
    expect(result?.todos[1]?.content).toBe('sub one');
    expect(result?.todos.every((t) => t.promotedFromPlan === 'a')).toBe(true);
  });

  it('mutatePlan loads-or-creates, applies the fn, and persists', async () => {
    const fp = path.join(dir, 'mutate.json');
    const updated = await mutatePlan(fp, 'sess-1', (p) => ({
      ...p,
      title: 'mutated',
      items: [{ id: 'x', title: 'New', status: 'pending' }],
      updatedAt: new Date().toISOString(),
    }));
    expect(updated.title).toBe('mutated');
    const reloaded = await loadPlan(fp);
    expect(reloaded?.items[0]?.id).toBe('x');
  });

  it('loadPlan returns null and emits a failure on a corrupt file', async () => {
    const events = { emit: vi.fn() };
    const fp = path.join(dir, 'plan.json');
    await fs.writeFile(fp, '{not valid', 'utf8');
    expect(await loadPlan(fp, events as never)).toBeNull();
    expect(events.emit.mock.calls.some((c) => c[0] === 'storage.read')).toBe(true);
  });

  it('savePlan emits storage.error and warns when the target is unwritable', async () => {
    const events = { emit: vi.fn() };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fileAsDir = path.join(dir, 'plan.json');
    await fs.mkdir(fileAsDir, { recursive: true });
    await savePlan(fileAsDir, mkPlan(), events as never);
    expect(events.emit.mock.calls.some((c) => c[0] === 'storage.error')).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
