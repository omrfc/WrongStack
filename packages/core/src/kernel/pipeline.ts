/**
 * Pipeline — Koa-style middleware chain with named middleware
 * and position-aware insertion. Generic over input type T.
 */

export type NextFn<T> = (value: T) => Promise<T>;
export type MiddlewareHandler<T> = (value: T, next: NextFn<T>) => Promise<T>;

export interface Middleware<T> {
  name: string;
  handler: MiddlewareHandler<T>;
  owner?: string;
}

export interface PipelineOptions {
  /** When true and the target middleware is not found, operations silently no-op instead of throwing. */
  optional?: boolean;
}

/**
 * Read-only view of a pipeline. Returned to consumers (plugins, hooks)
 * so they can inspect but not mutate the chain.
 */
export interface ReadonlyPipeline<T> {
  readonly size: number;
  list(): readonly string[];
  run(input: T): Promise<T>;
}

export class Pipeline<T> {
  private readonly chain: Middleware<T>[] = [];

  use(mw: Middleware<T>): this {
    this.ensureUnique(mw.name);
    this.chain.push(mw);
    return this;
  }

  prepend(mw: Middleware<T>): this {
    this.ensureUnique(mw.name);
    this.chain.unshift(mw);
    return this;
  }

  /**
   * Insert middleware at an explicit index. Out-of-range indices are clamped.
   * Use this when insertBefore/insertAfter are insufficient (e.g. to place
   * a middleware at a known position regardless of named targets).
   */
  insertAt(index: number, mw: Middleware<T>): this {
    this.ensureUnique(mw.name);
    const idx = Math.max(0, Math.min(index, this.chain.length));
    this.chain.splice(idx, 0, mw);
    return this;
  }

  /**
   * Insert mw immediately before the first occurrence of target.
   * If called multiple times with the same target, each call inserts
   * before the target's current position — so after insertBefore('B', X)
   * then insertBefore('B', Y), the order is Y → X → B.
   */
  insertBefore(target: string, mw: Middleware<T>, opts?: PipelineOptions): this {
    this.ensureUnique(mw.name);
    const idx = this.indexOf(target, opts?.optional);
    if (idx === -1) return this;
    this.chain.splice(idx, 0, mw);
    return this;
  }

  /**
   * Insert mw immediately after the first occurrence of target.
   * If called multiple times with the same target, each call inserts
   * after the target's current position — so after insertAfter('B', X)
   * then insertAfter('B', Y), the order is B → X → Y.
   */
  insertAfter(target: string, mw: Middleware<T>, opts?: PipelineOptions): this {
    this.ensureUnique(mw.name);
    const idx = this.indexOf(target, opts?.optional);
    if (idx === -1) return this;
    this.chain.splice(idx + 1, 0, mw);
    return this;
  }

  replace(target: string, mw: Middleware<T>, opts?: PipelineOptions): this {
    if (mw.name !== target) this.ensureUnique(mw.name);
    const idx = this.indexOf(target, opts?.optional);
    if (idx === -1) return this;
    this.chain[idx] = mw;
    return this;
  }

  remove(name: string, opts?: PipelineOptions): this {
    const idx = this.indexOf(name, opts?.optional);
    if (idx === -1) return this;
    this.chain.splice(idx, 1);
    return this;
  }

  list(): readonly string[] {
    return this.chain.map((m) => m.name);
  }

  size(): number {
    return this.chain.length;
  }

  /** Return a read-only view suitable for passing to plugins. */
  asReadonly(): ReadonlyPipeline<T> {
    // The returned object's methods close over `this`, so it always sees the live chain.
    // `list()` returns a frozen snapshot to prevent external mutation of the chain.
    const self = this;
    return Object.freeze({
      get size() { return self.size(); },
      list() { return Object.freeze(self.list()); },
      run(input: T) { return self.run(input); },
    });
  }

  async run(input: T): Promise<T> {
    let index = -1;
    const chain = this.chain;

    const dispatch = async (i: number, value: T): Promise<T> => {
      if (i <= index) {
        throw new Error(`Pipeline: next() called multiple times in "${chain[index]?.name}"`);
      }
      index = i;
      const mw = chain[i];
      if (!mw) return value;
      return mw.handler(value, (v) => dispatch(i + 1, v));
    };

    return dispatch(0, input);
  }

  private indexOf(name: string, optional = false): number {
    const idx = this.chain.findIndex((m) => m.name === name);
    if (idx === -1 && !optional) {
      throw new Error(`Pipeline: middleware "${name}" not found`);
    }
    return idx;
  }

  private ensureUnique(name: string): void {
    if (this.chain.some((m) => m.name === name)) {
      throw new Error(`Pipeline: middleware "${name}" already registered`);
    }
  }
}
