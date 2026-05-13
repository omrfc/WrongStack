import type { Provider } from '../types/provider.js';
import type { ProviderConfig } from '../types/config.js';
import type { WireFamily } from '../types/models-registry.js';

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

  register(f: ProviderFactory): void {
    this.factories.set(f.type, f);
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
