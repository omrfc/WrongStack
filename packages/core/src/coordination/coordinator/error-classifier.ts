import type { SubagentError, SubagentErrorKind } from '../../types/multi-agent.js';
import { ProviderError } from '../../types/provider.js';
import { AgentError } from '../../types/errors.js';
import { BudgetExceededError } from '../subagent-budget.js';

/**
 * Map any raw exception thrown out of a subagent's runner into a
 * structured `SubagentError`. This is the single point where the
 * coordinator decides "what kind of failure was that" — so callers
 * (delegate tool output, /agents UI, retry policies) branch on
 * `kind` instead of substring-matching `error.message`.
 *
 * Exported because tests and CLI surfaces want to assert on the
 * classification without instantiating a coordinator.
 */
export function classifySubagentError(
  err: unknown,
  hints: { parentAborted?: boolean | undefined } = {},
): SubagentError {
  // Unwrap AgentError wrappers — the runner wraps non-AgentError
  // throwables (ProviderError, TypeError, etc.) in AgentError so the
  // coordinator's try/catch catches a consistent type. Recurse into the
  // inner cause so classification sees the original error kind.
  if (err instanceof AgentError && err.cause) {
    return classifySubagentError(err.cause, hints);
  }

  const cause = err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : undefined;

  if (err instanceof ProviderError) {
    const baseMessage = err.describe();
    return providerErrorToSubagentError(err, baseMessage, cause);
  }

  const baseMessage = err instanceof Error ? err.message : String(err);

  if (err instanceof BudgetExceededError) {
    const map: Record<BudgetExceededError['kind'], SubagentErrorKind> = {
      iterations: 'budget_iterations',
      tool_calls: 'budget_tool_calls',
      tokens: 'budget_tokens',
      cost: 'budget_cost',
      timeout: 'budget_timeout',
      idle_timeout: 'budget_timeout',
    };
    return {
      kind: map[err.kind],
      message: baseMessage,
      retryable: false,
      cause,
    };
  }

  if (hints.parentAborted) {
    return { kind: 'aborted_by_parent', message: baseMessage, retryable: false, cause };
  }

  const lower = baseMessage.toLowerCase();
  if (/agent aborted$/i.test(baseMessage)) {
    return { kind: 'aborted_by_parent', message: baseMessage, retryable: false, cause };
  }
  if (/agent exhausted iteration limit$/i.test(baseMessage)) {
    return { kind: 'budget_iterations', message: baseMessage, retryable: false, cause };
  }
  if (/empty response/i.test(baseMessage)) {
    return { kind: 'empty_response', message: baseMessage, retryable: false, cause };
  }
  if (/^tool failed: /i.test(baseMessage)) {
    return { kind: 'tool_failed', message: baseMessage, retryable: false, cause };
  }
  if (lower.includes('bridge transport') || /bridge.*(closed|disconnect)/i.test(baseMessage)) {
    return { kind: 'bridge_failed', message: baseMessage, retryable: false, cause };
  }
  if (/context length|max.*tokens?.*exceeded|prompt is too long/i.test(baseMessage)) {
    return { kind: 'context_overflow', message: baseMessage, retryable: false, cause };
  }

  return { kind: 'unknown', message: baseMessage, retryable: false, cause };
}

function providerErrorToSubagentError(
  err: ProviderError,
  message: string,
  cause: SubagentError['cause'],
): SubagentError {
  const status = err.status;
  if (status === 429 || err.body?.type === 'rate_limit_error') {
    return { kind: 'provider_rate_limit', message, retryable: true, backoffMs: 5_000, cause };
  }
  if (status === 401 || status === 403 || err.body?.type === 'authentication_error') {
    return { kind: 'provider_auth', message, retryable: false, cause };
  }
  if (status === 408 || status === 0) {
    return { kind: 'provider_timeout', message, retryable: true, cause };
  }
  if (status >= 500 && status < 600) {
    return { kind: 'provider_5xx', message, retryable: true, backoffMs: 3_000, cause };
  }
  return { kind: 'unknown', message, retryable: err.retryable, cause };
}
