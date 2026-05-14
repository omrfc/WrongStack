import type { Config, ConfigStore } from '../types/config.js';

/**
 * Reference implementation of `ConfigStore`. Stores a single frozen Config
 * and notifies watchers synchronously on every update. Updates use a deep
 * clone so callers can mutate their `partial` argument freely without
 * tainting state.
 *
 * For the CLI: instantiate once at boot, pass the store (not the Config)
 * to subsystems that care about runtime changes (provider switching,
 * extension reload).
 */
export class DefaultConfigStore implements ConfigStore {
  private current: Readonly<Config>;
  private watchers = new Set<(next: Readonly<Config>, prev: Readonly<Config>) => void>();

  constructor(initial: Config) {
    this.current = deepFreeze(structuredClone(initial));
  }

  get(): Readonly<Config> {
    return this.current;
  }

  getSection<K extends keyof Config>(key: K): Readonly<Config[K]> {
    return this.current[key] as Readonly<Config[K]>;
  }

  getExtension(pluginName: string): Readonly<Record<string, unknown>> {
    const ext = this.current.extensions?.[pluginName];
    return ext ? (ext as Readonly<Record<string, unknown>>) : FROZEN_EMPTY;
  }

  update(partial: Partial<Config>): Readonly<Config> {
    // Shallow merge — top-level fields replace, nested objects do too unless
    // the caller passes a fully-formed sub-object. That matches the JSON
    // config user mental model (replace `tools.maxIterations` by passing
    // the whole `tools` block, or by patching `extensions.<name>`).
    const next = deepFreeze(
      structuredClone({ ...this.current, ...partial }),
    ) as Readonly<Config>;

    if (next.version !== 1) {
      throw new Error(`ConfigStore.update: version must remain 1, got ${String(next.version)}`);
    }

    const prev = this.current;
    this.current = next;
    // Notify watchers AFTER mutating `current` so re-entrant watcher reads
    // see the new state. Watcher exceptions are caught individually so one
    // misbehaving subscriber can't block the others.
    for (const w of this.watchers) {
      try {
        w(next, prev);
      } catch (err) {
        // A plugin watcher that crashes on /model switch or similar would
        // otherwise leave the system in a quietly-inconsistent state. We
        // still don't propagate (one bad subscriber must not break the
        // others), but we surface the error so it's discoverable.
        console.error('[config-store] watcher threw:', err);
      }
    }
    return next;
  }

  watch(cb: (next: Readonly<Config>, prev: Readonly<Config>) => void): () => void {
    this.watchers.add(cb);
    return () => this.watchers.delete(cb);
  }
}

const FROZEN_EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  for (const key of Object.keys(obj as object)) {
    const v = (obj as Record<string, unknown>)[key];
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return Object.freeze(obj);
}
