import type { ModelsRegistry, SecretScrubber, SecretVault } from '@wrongstack/core';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';

/**
 * Dependencies shared across all auth-menu modules.
 * Kept deliberately light — each sub-module takes only the subset it needs.
 */
export interface AuthMenuDeps {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  modelsRegistry: ModelsRegistry;
  vault: SecretVault;
  globalConfigPath: string;
  /**
   * Optional scrubber used by `wstack auth local` to redact Bearer
   * tokens from probe logs before they reach the renderer. Falls back
   * to a fresh {@link DefaultSecretScrubber} when not supplied.
   */
  secretScrubber?: SecretScrubber | undefined;
}
