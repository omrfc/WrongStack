/**
 * StrategyRegistry — generic strategy pattern registry.
 *
 * Allows plugins to register named strategies for any subsystem
 * (tool execution, compaction, error recovery, etc.).
 */

export interface StrategyDefinition<T = unknown, R = unknown> {
  name: string;
  execute: (input: T, ctx?: unknown) => R | Promise<R>;
  description?: string;
}

export class StrategyRegistry {
  private readonly strategies = new Map<string, Map<string, StrategyDefinition>>();

  /**
   * Register a strategy under a category.
   */
  register<T, R>(
    category: string,
    name: string,
    execute: (input: T, ctx?: unknown) => R | Promise<R>,
    description?: string,
  ): void {
    let cat = this.strategies.get(category);
    if (!cat) {
      cat = new Map();
      this.strategies.set(category, cat);
    }
    if (cat.has(name)) {
      throw new Error(`StrategyRegistry: "${category}.${name}" already registered`);
    }
    cat.set(name, { name, execute: execute as StrategyDefinition['execute'], description });
  }

  /**
   * Override an existing strategy.
   */
  override<T, R>(
    category: string,
    name: string,
    execute: (input: T, ctx?: unknown) => R | Promise<R>,
    description?: string,
  ): void {
    let cat = this.strategies.get(category);
    if (!cat) {
      cat = new Map();
      this.strategies.set(category, cat);
    }
    cat.set(name, { name, execute: execute as StrategyDefinition['execute'], description });
  }

  /**
   * Get a strategy by category and name.
   */
  get<T, R>(category: string, name: string): StrategyDefinition<T, R> | undefined {
    return this.strategies.get(category)?.get(name) as StrategyDefinition<T, R> | undefined;
  }

  /**
   * Execute a strategy by name.
   */
  async execute<T, R>(category: string, name: string, input: T, ctx?: unknown): Promise<R> {
    const strategy = this.get<T, R>(category, name);
    if (!strategy) {
      throw new Error(`StrategyRegistry: "${category}.${name}" not found`);
    }
    return strategy.execute(input, ctx) as Promise<R>;
  }

  /**
   * Check if a strategy exists.
   */
  has(category: string, name: string): boolean {
    return this.strategies.get(category)?.has(name) ?? false;
  }

  /**
   * List strategies in a category.
   */
  list(category: string): string[] {
    return Array.from(this.strategies.get(category)?.keys() ?? []);
  }

  /**
   * List all categories.
   */
  categories(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * Unregister a strategy.
   */
  unregister(category: string, name: string): boolean {
    return this.strategies.get(category)?.delete(name) ?? false;
  }

  /**
   * Unregister an entire category.
   */
  unregisterCategory(category: string): boolean {
    return this.strategies.delete(category);
  }
}
