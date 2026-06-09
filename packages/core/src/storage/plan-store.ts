import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ConversationState } from '../core/conversation-state.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';

/**
 * Plan items are the strategic counterpart to todos. Where `ctx.todos`
 * is the moment-to-moment task board the LLM mutates per-turn, a plan
 * captures the higher-level approach — the steps the user (or LLM)
 * laid out before any work began.
 *
 * Plans persist by default (per session) so a resumed session can show
 * "you were on step 3 of 5". Todos are derived/transient. Both can
 * coexist: think roadmap (plan) vs. sprint board (todos).
 */
export interface PlanItem {
  id: string;
  title: string;
  /** Optional longer-form context or rationale. */
  details?: string | undefined;
  status: 'open' | 'in_progress' | 'done';
  createdAt: string;
  updatedAt: string;
}

export interface PlanFile {
  version: 1;
  sessionId: string;
  title?: string | undefined;
  updatedAt: string;
  items: PlanItem[];
}

export async function loadPlan(filePath: string): Promise<PlanFile | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PlanFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function savePlan(filePath: string, plan: PlanFile): Promise<void> {
  try {
    await atomicWrite(filePath, JSON.stringify(plan, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn(
      '[plan-store] save failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Create a new PlanFile when none exists on disk. */
export function emptyPlan(sessionId: string, title?: string): PlanFile {
  return {
    version: 1,
    sessionId,
    title,
    updatedAt: new Date().toISOString(),
    items: [],
  };
}

export function addPlanItem(
  plan: PlanFile,
  title: string,
  details?: string | undefined,
): { plan: PlanFile; item: PlanItem } {
  const now = new Date().toISOString();
  const item: PlanItem = {
    id: `plan_${Date.now()}_${randomUUID().slice(0, 6)}`,
    title,
    details,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
  return {
    plan: { ...plan, items: [...plan.items, item], updatedAt: now },
    item,
  };
}

export function removePlanItem(plan: PlanFile, idOrIndex: string): PlanFile {
  const idx = matchIndex(plan, idOrIndex);
  if (idx === -1) return plan;
  return {
    ...plan,
    items: plan.items.filter((_, i) => i !== idx),
    updatedAt: new Date().toISOString(),
  };
}

export function setPlanItemStatus(
  plan: PlanFile,
  idOrIndex: string,
  status: PlanItem['status'],
): PlanFile {
  const idx = matchIndex(plan, idOrIndex);
  if (idx === -1) return plan;
  const now = new Date().toISOString();
  const items = plan.items.map((it, i) =>
    i === idx ? { ...it, status, updatedAt: now } : it,
  );
  return { ...plan, items, updatedAt: now };
}

export function clearPlan(plan: PlanFile): PlanFile {
  return { ...plan, items: [], updatedAt: new Date().toISOString() };
}

/** Render the plan as a short markdown-ish string suitable for slash output. */
export function formatPlan(plan: PlanFile): string {
  if (plan.items.length === 0) return 'Plan is empty.';
  const lines: string[] = [];
  if (plan.title) lines.push(`# ${plan.title}`);
  plan.items.forEach((it, i) => {
    const mark = it.status === 'done' ? '[x]' : it.status === 'in_progress' ? '[~]' : '[ ]';
    lines.push(`${i + 1}. ${mark} ${it.title}`);
    if (it.details) {
      for (const line of it.details.split('\n')) lines.push(`     ${line}`);
    }
  });
  return lines.join('\n');
}

function matchIndex(plan: PlanFile, idOrIndex: string): number {
  const asNum = Number.parseInt(idOrIndex, 10);
  if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= plan.items.length) return asNum - 1;
  const byId = plan.items.findIndex((it) => it.id === idOrIndex);
  if (byId !== -1) return byId;
  const lower = idOrIndex.toLowerCase();
  return plan.items.findIndex((it) => it.title.toLowerCase().includes(lower));
}

/**
 * Promote a plan item to a set of todo items.
 * The plan item is marked 'in_progress' (if not already done) and its
 * title + details become the first todo; additional subtasks are appended.
 * Returns the derived todo list so the caller can pass it to `todoTool`
 * or `ctx.state.replaceTodos()`.
 */
export function deriveTodosFromPlanItem(
  plan: PlanFile,
  idOrIndex: string,
  subtasks?: string[] | undefined,
): { plan: PlanFile; todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string | undefined }> } | null {
  const idx = matchIndex(plan, idOrIndex);
  if (idx === -1) return null;

  const item = plan.items[idx];
  if (!item) return null;

  // Mark the plan item in_progress if it wasn't already done
  let updatedPlan = plan;
  if (item.status !== 'done') {
    updatedPlan = setPlanItemStatus(plan, idOrIndex, 'in_progress');
  }

  const todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string | undefined }> = [];

  // First todo from the plan item itself
  todos.push({
    id: `todo_${Date.now()}_plan`,
    content: item.title,
    status: 'in_progress',
    activeForm: item.title,
  });

  // Optional subtasks
  if (subtasks && subtasks.length > 0) {
    for (const st of subtasks) {
      todos.push({
        id: `todo_${Date.now()}_${randomUUID().slice(0, 6)}`,
        content: st,
        status: 'pending',
      });
    }
  }

  return { plan: updatedPlan, todos };
}

/**
 * Load, modify, and save the plan file under a file-level lock.
 * Prevents races from parallel tool invocations (e.g. batch_tool_use).
 */
export async function mutatePlan(
  filePath: string,
  sessionId: string,
  fn: (plan: PlanFile) => PlanFile | Promise<PlanFile>,
): Promise<PlanFile> {
  return withFileLock(filePath, async () => {
    const plan = (await loadPlan(filePath)) ?? emptyPlan(sessionId);
    const updated = await fn(plan);
    await savePlan(filePath, updated);
    return updated;
  });
}

/**
 * Optional: attach a state-listener so meta operations (storing a plan
 * id on ctx.meta) trigger a save. Currently a stub — plans don't live
 * on Context, but this keeps the API surface symmetric with the todos
 * checkpoint so future refactors can flip plans into Context if needed.
 */
export function attachPlanCheckpoint(
  _state: ConversationState,
  _filePath: string,
  _sessionId: string,
): () => void {
  return () => undefined;
}
