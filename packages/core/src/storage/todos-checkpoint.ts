import * as fsp from 'node:fs/promises';
import type { EventBus } from '../kernel/events.js';
import type { TodoItem } from '../core/context.js';
import type { ConversationState } from '../core/conversation-state.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';

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
export async function loadTodosCheckpoint(
  filePath: string,
  events?: EventBus,
  traceId?: string,
): Promise<TodoItem[] | null> {
  const t0 = Date.now();
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: traceId ?? '~boot~',
      store: 'todos',
      filePath,
      operation: 'load',
      outcome: 'failure',
      error: toErrorMessage(err),
      recoverable: true,
    });
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as TodosCheckpointFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.todos)) {
      events?.emit('storage.read', {
        sessionId: traceId ?? '~boot~',
        store: 'todos',
        filePath,
        operation: 'load',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'invalid_schema',
        ...(traceId !== undefined && { traceId }),
      });
      return null;
    }
    events?.emit('storage.read', {
      sessionId: traceId ?? '~boot~',
      store: 'todos',
      filePath,
      operation: 'load',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(traceId !== undefined && { traceId }),
    });
    return parsed.todos.filter(
      (t): t is TodoItem =>
        !!t &&
        typeof t.id === 'string' &&
        typeof t.content === 'string' &&
        typeof t.status === 'string' &&
        (t.activeForm === undefined || typeof t.activeForm === 'string'),
    );
  } catch {
    events?.emit('storage.read', {
      sessionId: traceId ?? '~boot~',
      store: 'todos',
      filePath,
      operation: 'load',
      outcome: 'failure',
      durationMs: Date.now() - t0,
      error: 'parse_failed',
      ...(traceId !== undefined && { traceId }),
    });
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
  events?: EventBus,
  traceId?: string,
): Promise<void> {
  const t0 = Date.now();
  const payload: TodosCheckpointFile = {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    todos: [...todos],
  };
  try {
    await atomicWrite(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    events?.emit('storage.write', {
      sessionId: traceId ?? sessionId,
      store: 'todos',
      filePath,
      operation: 'save',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(traceId !== undefined && { traceId }),
    });
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: traceId ?? sessionId,
      store: 'todos',
      filePath,
      operation: 'save',
      outcome: 'failure',
      error: toErrorMessage(err),
      recoverable: false,
    });
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'todos_checkpoint.save_failed',
      message: toErrorMessage(err),
      timestamp: new Date().toISOString(),
    }));
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
  events?: EventBus,
  traceId?: string,
): TodosCheckpointDetach {
  let timer: NodeJS.Timeout | null = null;
  let pending: readonly TodoItem[] | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  const enqueueWrite = (todos: readonly TodoItem[]) => {
    writeChain = writeChain
      .then(() => saveTodosCheckpoint(filePath, sessionId, todos, events, traceId))
      /* v8 ignore start -- defensive: saveTodosCheckpoint swallows its own errors and never rejects */
      .catch((err) => {
        // Log and keep the chain alive — a failed write must not
        // poison the chain and silently stop all subsequent writes.
        const msg = toErrorMessage(err);
        console.error(JSON.stringify({
          level: 'error',
          event: 'todos_checkpoint.write_chain_failed',
          sessionId,
          message: msg,
          timestamp: new Date().toISOString(),
        }));
      });
      /* v8 ignore stop */
    return writeChain;
  };

  const flush = () => {
    timer = null;
    if (pending) {
      const todos = pending;
      pending = null;
      return enqueueWrite(todos);
    }
    /* v8 ignore next -- defensive: flush is only invoked when a change is pending */
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
