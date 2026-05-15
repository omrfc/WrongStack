import type { ProviderConfig } from '../types/config.js';
import type { WireFamily } from '../types/models-registry.js';
import type { Provider } from '../types/provider.js';

/**
 * Factory for constructing a Provider instance. The `family` field
 * declares the wire protocol so callers can route without inspecting
 * the returned instance. The `type` is the registry key (e.g. a
 * provider's models.dev id or a user-chosen alias).
 */
export interface ProviderFactory {
  /**
   * Unique identifier used as the registry key. When registered via
   * a plugin, this becomes `cfg.type` in `ProviderRegistry.create(cfg)`.
   */
  type: string;
  /**
   * Declares the wire protocol family so consumers can route based on
   * capability (e.g. which tool-format converter to use) without
   * instantiating the provider.
   */
  family: WireFamily;
  create(cfg: ProviderConfig): Provider;
}

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  /**
   * Register a provider factory. If a factory with the same type already
   * exists, it is replaced. Use this for both initial registration and
   * runtime overrides (e.g. from plugins or CLI flags).
   */
  register(f: ProviderFactory): void {
    this.factories.set(f.type, f);
  }

  /**
   * Override an existing factory. Throws if no factory is registered
   * for the given type. Use this to safely replace a provider at runtime
   * (e.g. in tests or when a plugin provides a custom implementation).
   */
  override(type: string, f: ProviderFactory): void {
    if (!this.factories.has(type)) {
      throw new Error(`Provider type "${type}" not registered; cannot override`);
    }
    this.factories.set(type, f);
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  create(cfg: ProviderConfig): Provider {
    const f = this.factories.get(cfg.type);
    if (!f) {
      throw new Error(
        `Provider type "${cfg.type}" not registered. Available: ${Array.from(this.factories.keys()).join(', ')}`,
      );
    }
    return f.create(cfg);
  }

  list(): string[] {
    return Array.from(this.factories.keys());
  }
}
