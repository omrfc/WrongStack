import { useMemo } from 'react';
import type { TokenCounter } from '@wrongstack/core';

/** Snapshot of the live context window, suitable for the status-bar chip. */
export interface ContextWindow {
  /** Tokens the model was just asked to process (input + cacheRead). */
  used: number;
  /** MaxContext for the active model — the denominator. */
  max: number;
}

export interface UseContextWindowOptions {
  /** Live max context for the active model. CLI passes the startup value;
   *  /model and ctx.pct events keep it in sync with the live agent context. */
  activeMaxContext: number | undefined;
  /** Fallback max context when activeMaxContext is undefined. */
  providerMaxContext: number;
  /** Live token counter (optional). When undefined, `used` falls back to 0. */
  tokenCounter: TokenCounter | undefined;
  /** Bumps the memo so external ctx.pct events trigger re-render. */
  contextChipVersion: number;
}

/**
 * Computes the live `ContextWindow` snapshot for the status-bar chip.
 *
 * Per-request context pressure = current prompt tokens (input + cacheRead).
 * Cached tokens (cacheWrite) are excluded because they are an accounting
 * artifact of THIS request (provider charges for them separately); they
 * are already counted in `usage.input` as part of the prompt the model sees.
 *
 * The cumulative `tokenCounter.total()` is intentionally NOT used here — it
 * grows across all turns. For the context fullness bar we want the live size
 * of the conversation as it sat on the wire — that's what determines how
 * close we are to the model's max context window.
 */
export function useContextWindow({
  activeMaxContext,
  providerMaxContext,
  tokenCounter,
  contextChipVersion,
}: UseContextWindowOptions): ContextWindow | undefined {
  const maxContext = activeMaxContext ?? providerMaxContext;
  const currentContextTokens =
    (tokenCounter?.currentRequestTokens()?.input ?? 0) +
    (tokenCounter?.currentRequestTokens()?.cacheRead ?? 0);

  return useMemo(() => {
    void contextChipVersion;
    return currentContextTokens > 0 && maxContext > 0
      ? { used: currentContextTokens, max: maxContext }
      : undefined;
  }, [currentContextTokens, maxContext, contextChipVersion]);
}
