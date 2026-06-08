import * as fsp from 'node:fs/promises';
import { atomicWrite } from '../utils/atomic-write.js';
import type { TaskItem } from '../utils/task-format.js';

// ---------------------------------------------------------------------------
// Task file persistence — one JSON file per session in
// `<projectSessions>/<sessionId>.tasks.json`.
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
