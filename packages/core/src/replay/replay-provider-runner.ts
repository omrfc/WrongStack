import { hashRequest } from './hash.js';
import type { ReplayLogStore } from '../storage/replay-log-store.js';
import type { ProviderRunner, RunProviderOptions } from '../types/provider-runner.js';
import type { Response } from '../types/provider.js';

/**
 * ReplayProviderRunner — idea #2 from IDEAS.md.
 *
 * A drop-in `ProviderRunner` that wraps an inner runner and either
 *   - records every (request, response) pair it observes (mode: 'record'),
 *   - serves a recorded response when the request hash matches (mode: 'replay'),
 *   - or does both: serve when present, record when not (mode: 'auto').
 *
 * Bind to `TOKENS.ProviderRunner` to completely replace the default
 * runner. Or use `AgentExtension.wrapProviderRunner` to chain in
 * alongside other extensions.
 *
 * Mode semantics:
 *   - 'record' is the production mode. Every real API call is
 *     persisted; the user can later `wstack replay <sessionId>` to
 *     re-run with frozen responses.
 *   - 'replay' is the debugging mode. The agent loop runs normally
 *     (same permissions, same tool dispatch) but every LLM call
 *     comes from the recorded log. If a request hash is not in the
 *     log, we throw — the user is expected to either rebuild the
 *     session or fall back to record mode.
 *   - 'auto' is the warm-start mode for development. The first time
 *     a particular request is seen, it's recorded; the next time
 *     the same request is made, the recorded response is served.
 *     This is the cheapest path to a deterministic test harness.
 */
export type ReplayMode = 'record' | 'replay' | 'auto';

export interface ReplayProviderRunnerOptions {
  log: ReplayLogStore;
  sessionId: string;
  mode: ReplayMode;
  /**
   * Optional logger — receives a debug line on every replay hit
   * ("served cached response for hash sha256:…") and a warn on
   * every miss in 'replay' mode (the throw that follows is the
   * real signal, but the warn helps when the throw is caught
   * upstream).
   */
  logger?: {
    debug?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
}

export class ReplayProviderRunner implements ProviderRunner {
  constructor(
    private readonly inner: ProviderRunner,
    private readonly opts: ReplayProviderRunnerOptions,
  ) {}

  async run(runOpts: RunProviderOptions): Promise<Response> {
    const hash = hashRequest(runOpts.request);
    const cached = await this.opts.log.lookup(this.opts.sessionId, hash);

    if (this.opts.mode === 'replay') {
      if (!cached) {
        this.opts.logger?.warn?.(
          `replay: no recorded response for hash ${hash} (model ${runOpts.request.model})`,
        );
        throw new Error(
          `ReplayProviderRunner: no recorded response for hash ${hash} in session ${this.opts.sessionId}. ` +
            `Either the request changed since recording, or this session has no replay log.`,
        );
      }
      this.opts.logger?.debug?.(
        `replay: served cached response for hash ${hash} (recorded ${cached.ts})`,
      );
      return cached.response;
    }

    if (this.opts.mode === 'auto' && cached) {
      this.opts.logger?.debug?.(
        `replay: auto-hit hash ${hash}, served cached response`,
      );
      return cached.response;
    }

    // 'record' or 'auto' with no cache hit — delegate to the inner runner.
    const response = await this.inner.run(runOpts);
    await this.opts.log.record({
      sessionId: this.opts.sessionId,
      request: runOpts.request,
      response,
    });
    return response;
  }
}
