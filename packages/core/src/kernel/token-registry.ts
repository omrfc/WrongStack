/**
 * TokenRegistry — dynamic token registration for the DI container.
 *
 * Unlike the static TOKENS object, TokenRegistry allows plugins and
 * extensions to register new tokens at runtime without modifying core.
 */

import type { Token } from './container.js';

const t = <T>(name: string): Token<T> => Symbol(name) as Token<T>;

export interface RegisteredToken<T = unknown> {
  name: string;
  token: Token<T>;
  description?: string;
}

export class TokenRegistry {
  private readonly tokens = new Map<string, RegisteredToken>();

  /**
   * Register a new token. Throws if the name is already registered.
   */
  register<T>(name: string, description?: string): Token<T> {
    if (this.tokens.has(name)) {
      throw new Error(`TokenRegistry: token "${name}" already registered`);
    }
    const token = t<T>(name);
    this.tokens.set(name, { name, token, description });
    return token;
  }

  /**
   * Get a token by name. Returns undefined if not found.
   */
  get<T>(name: string): Token<T> | undefined {
    return this.tokens.get(name)?.token as Token<T> | undefined;
  }

  /**
   * Check if a token is registered.
   */
  has(name: string): boolean {
    return this.tokens.has(name);
  }

  /**
   * List all registered token names.
   */
  list(): string[] {
    return Array.from(this.tokens.keys());
  }

  /**
   * Get metadata for a token.
   */
  metadata(name: string): RegisteredToken | undefined {
    return this.tokens.get(name);
  }

  /**
   * Unregister a token. Returns true if it existed.
   */
  unregister(name: string): boolean {
    return this.tokens.delete(name);
  }

  /**
   * Create a token only if it doesn't exist, otherwise return existing.
   */
  ensure<T>(name: string, description?: string): Token<T> {
    const existing = this.get<T>(name);
    if (existing) return existing;
    return this.register<T>(name, description);
  }
}
