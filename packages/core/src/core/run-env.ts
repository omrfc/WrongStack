import type { TextBlock } from '../types/blocks.js';
import type { Provider } from '../types/provider.js';
import type { SessionWriter } from '../types/session.js';
import type { TokenCounter } from '../types/token-counter.js';
import type { Tool } from '../types/tool.js';
import type { Context } from './context.js';

/**
 * Immutable run environment — the set-once dependencies for an agent run.
 *
 * `Context` today doubles as both a DI bag (provider, session, tokenCounter,
 * cwd, …) and a mutable state container (messages, todos, meta). That makes
 * it hard to test (every test reconstructs the full bag) and easy to abuse
 * (any tool can swap the provider mid-run).
 *
 * `RunEnv` is the immutable half: a read-only projection that subsystems
 * can hold instead of the whole `Context`. It's a view, not a copy — pulling
 * a `RunEnv` from a `Context` is O(1) and reflects the same underlying
 * references. The opposite direction (set things on Context) still works,
 * and `extractRunEnv` rebuilds the view if you need a snapshot.
 *
 * Migration path: new APIs accept `RunEnv` instead of `Context` when they
 * only need read access. Existing APIs continue to accept `Context` until
 * a full split is scheduled.
 */
export interface RunEnv {
  readonly provider: Provider;
  readonly session: SessionWriter;
  readonly signal: AbortSignal;
  readonly tokenCounter: TokenCounter;
  readonly cwd: string;
  readonly projectRoot: string;
  /** Mutable working directory — starts as `cwd`. */
  readonly workingDir: string;
  readonly model: string;
  readonly systemPrompt: readonly TextBlock[];
  readonly tools: readonly Tool[];
}

/**
 * Build a `RunEnv` view from a Context. The returned object is a shallow
 * frozen view — mutations to `Context` are visible (it's the same
 * references), but the view itself can't be mutated.
 *
 * Use this in subsystems that want to declare "I only need read access to
 * the env" without rewriting their signature to accept the full Context.
 */
export function extractRunEnv(ctx: Context): RunEnv {
  return Object.freeze({
    provider: ctx.provider,
    session: ctx.session,
    signal: ctx.signal,
    tokenCounter: ctx.tokenCounter,
    cwd: ctx.cwd,
    projectRoot: ctx.projectRoot,
    workingDir: ctx.workingDir,
    model: ctx.model,
    systemPrompt: ctx.systemPrompt,
    tools: ctx.tools,
  });
}
