import * as fsp from 'node:fs/promises';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import type { TaskItem } from '../utils/task-format.js';

// ---------------------------------------------------------------------------
// Task file persistence — one JSON file per session in
// `<projectSessions>/<sessionId>.tasks.json`.
//
// Low-level load/save are exported for read-only consumers. Mutating callers
// should use `mutateTasks` which wraps the entire read-modify-write cycle
// under a file-level lock, preventing races from parallel tool invocations.
// ---------------------------------------------------------------------------

export interface TaskFile {
  version: 1;
  sessionId: string;
  updatedAt: string;
  tasks: TaskItem[];
}

export function emptyTaskFile(sessionId: string): TaskFile {
  return {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    tasks: [],
  };
}

/** Read the task file. Returns null when the file doesn't exist. */
export async function loadTasks(filePath: string): Promise<TaskFile | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as TaskFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write the task file atomically. Prefer `mutateTasks` for read-modify-write
 * cycles — this low-level function does NOT acquire a lock.
 */
export async function saveTasks(filePath: string, tasks: TaskFile): Promise<void> {
  try {
    tasks.updatedAt = new Date().toISOString();
    await atomicWrite(filePath, JSON.stringify(tasks, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn(
      '[task-store] save failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Load, modify, and save the task file under a file-level lock.
 * `fn` receives the current TaskFile (or a fresh empty one) and must
 * return the mutated TaskFile (mutating in-place is fine — the returned
 * reference is what gets saved).
 *
 * This is the primary API for any code path that reads *and then writes*
 * the task file — it prevents races from parallel `batch_tool_use` calls.
 */
export async function mutateTasks(
  filePath: string,
  sessionId: string,
  fn: (file: TaskFile) => TaskFile | Promise<TaskFile>,
): Promise<TaskFile> {
  return withFileLock(filePath, async () => {
    const file = (await loadTasks(filePath)) ?? emptyTaskFile(sessionId);
    const updated = await fn(file);
    await saveTasks(filePath, updated);
    return updated;
  });
}
