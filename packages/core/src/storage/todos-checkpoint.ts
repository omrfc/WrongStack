import * as fsp from 'node:fs/promises';
import type { TodoItem } from '../core/context.js';
import type { ConversationState } from '../core/conversation-state.js';
import { atomicWrite } from '../utils/atomic-write.js';

/**
 * On-disk checkpoint for `ctx.todos`. Written atomically every time the
 * todo list changes, read once on session resume. This is the missing
 * piece that lets `wstack resume <id>` rehydrate where the previous run
 * stopped instead of starting with an empty board.
 *
 * Schema is intentionally small — a single JSON object so a future
 * format bump is easy. The `version` field is the only contract; the
 * shape under `todos` mirrors `TodoItem` so reading is a straight assign.
 */
export interface TodosCheckpointFile {
  version: 1;
  sessionId: string;
  updatedAt: string;
  todos: TodoItem[];
}

export type TodosCheckpointDetach = () => Promise<void>;

/** Read a checkpoint from disk. Returns null when the file doesn't
 *  exist or is corrupt — callers treat both cases as "no prior state".
 */
export async function loadTodosCheckpoint(filePath: string): Promise<TodoItem[] | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as TodosCheckpointFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.todos)) return null;
    return parsed.todos.filter(
      (t): t is TodoItem =>
        !!t && typeof t.id === 'string' && typeof t.content === 'string' && typeof t.status === 'string',
    );
  } catch {
    return null;
  }
}

/** Write the checkpoint atomically. Best-effort: a write failure is
 *  logged but does not throw — losing one checkpoint shouldn't bring
 *  down the agent run.
 */
export async function saveTodosCheckpoint(
  filePath: string,
  sessionId: string,
  todos: readonly TodoItem[],
): Promise<void> {
  const payload: TodosCheckpointFile = {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    todos: [...todos],
  };
  try {
    await atomicWrite(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn(
      '[todos-checkpoint] save failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Subscribe a `ConversationState` so every `todos_replaced` mutation
 * triggers an atomic write to disk. Returns the unsubscribe function.
 *
 * Writes are debounced by 150ms so a flurry of edits (e.g. the LLM
 * marking three items done in the same tool call) coalesces into one
 * disk hit.
 */
export function attachTodosCheckpoint(
  state: ConversationState,
  filePath: string,
  sessionId: string,
): TodosCheckpointDetach {
  let timer: NodeJS.Timeout | null = null;
  let pending: readonly TodoItem[] | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  const enqueueWrite = (todos: readonly TodoItem[]) => {
    writeChain = writeChain.then(() => saveTodosCheckpoint(filePath, sessionId, todos));
    return writeChain;
  };

  const flush = () => {
    timer = null;
    if (pending) {
      const todos = pending;
      pending = null;
      return enqueueWrite(todos);
    }
    return writeChain;
  };

  const unsubscribe = state.onChange((change) => {
    if (change.kind !== 'todos_replaced') return;
    pending = change.todos;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, 150);
  });
  return async () => {
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
      // Flush any pending write before detach so callers can safely
      // unsubscribe at shutdown without losing the last update.
      await flush();
    } else {
      await writeChain;
    }
  };
}
