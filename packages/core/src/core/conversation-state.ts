import type { Message } from '../types/messages.js';
import type { Context, TodoItem } from './context.js';

/**
 * Observable wrapper for mutable conversation state. Production code should
 * mutate messages, todos, and meta through this API so subscribers see a
 * deterministic change stream. The underlying Context arrays are still
 * exposed for read compatibility and legacy tests.
 *
 * L1-A invariant: direct mutations of `ctx.messages` / `ctx.todos` bypass
 * the observer layer. Prefer `ctx.state.appendMessage()` etc. to keep
 * subscribers in sync. The compatibility arrays exist so existing code
 * that reads `ctx.messages` directly still works — they are NOT safe for
 * external writes.
 */
export type StateChange =
  | { kind: 'message_appended'; message: Message }
  | { kind: 'messages_replaced'; messages: readonly Message[] }
  | { kind: 'todos_replaced'; todos: readonly TodoItem[] }
  | { kind: 'meta_set'; key: string; value: unknown }
  | { kind: 'meta_deleted'; key: string }
  | { kind: 'meta_cleared' };

export type StateChangeHandler = (change: StateChange, state: ConversationState) => void;

export interface ReadonlyConversationState {
  readonly messages: readonly Message[];
  readonly todos: readonly TodoItem[];
  readonly meta: Readonly<Record<string, unknown>>;
}

export class ConversationState {
  private readonly ctx: Context;
  private readonly listeners = new Set<StateChangeHandler>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  get messages(): readonly Message[] {
    return this.ctx.messages;
  }

  get todos(): readonly TodoItem[] {
    return this.ctx.todos;
  }

  get meta(): Readonly<Record<string, unknown>> {
    return this.ctx.meta;
  }

  /**
   * Cheap immutable snapshot. Useful for tests and for compaction passes
   * that need a stable view across an async boundary.
   */
  snapshot(): ReadonlyConversationState {
    // Return a deep-frozen view — both the arrays and the message/todo/meta
    // objects they contain are immutable so callers can't accidentally mutate
    // state through a snapshot reference.
    return deepFreeze({
      messages: [...this.ctx.messages],
      todos: [...this.ctx.todos],
      meta: { ...this.ctx.meta },
    });
  }

  appendMessage(message: Message): void {
    this.ctx.messages.splice(this.ctx.messages.length, 0, message);
    this.emit({ kind: 'message_appended', message });
  }

  replaceMessages(messages: Message[]): void {
    this.ctx.messages.length = 0;
    this.ctx.messages.splice(0, 0, ...messages);
    this.emit({ kind: 'messages_replaced', messages: [...messages] });
  }

  replaceTodos(todos: TodoItem[]): void {
    this.ctx.todos.length = 0;
    this.ctx.todos.splice(0, 0, ...todos);
    this.emit({ kind: 'todos_replaced', todos: [...todos] });
  }

  setMeta(key: string, value: unknown): void {
    this.ctx.meta[key] = value;
    this.emit({ kind: 'meta_set', key, value });
  }

  deleteMeta(key: string): void {
    if (!(key in this.ctx.meta)) return;
    delete this.ctx.meta[key];
    this.emit({ kind: 'meta_deleted', key });
  }

  clearMeta(): void {
    const keys = Object.keys(this.ctx.meta);
    if (keys.length === 0) return;
    for (const key of keys) delete this.ctx.meta[key];
    this.emit({ kind: 'meta_cleared' });
  }

  /**
   * Subscribe to mutations that go through this wrapper. Direct mutations of
   * the compatibility arrays are intentionally not observed.
   */
  onChange(listener: StateChangeHandler): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StateChange): void {
    for (const h of this.listeners) {
      try {
        h(change, this);
      } catch {
        // Listeners are observational only; one bad subscriber must not
        // prevent state mutation or block sibling listeners.
      }
    }
  }
}

/**
 * Convenience constructor. The wrapper holds a reference, not a copy.
 */
export function wrapAsState(ctx: Context): ConversationState {
  return new ConversationState(ctx);
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const v = (obj as Record<string, unknown>)[key];
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return obj;
}
