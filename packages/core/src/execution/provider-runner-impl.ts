import type { ProviderRunner, RunProviderOptions } from '../types/provider-runner.js';
import { runProviderWithRetry } from '../core/provider-runner.js';
import type { Response } from '../types/provider.js';

/**
 * Default ProviderRunner — thin adapter over `runProviderWithRetry`.
 *
 * This is bound to `TOKENS.ProviderRunner` by the CLI at boot.
 * Consumers that want to replace the provider calling layer entirely
 * can bind a different implementation to the same token before
 * `Agent.run()`.
 */
export class DefaultProviderRunner implements ProviderRunner {
  async run(opts: RunProviderOptions): Promise<Response> {
    return runProviderWithRetry(opts);
  }
}
