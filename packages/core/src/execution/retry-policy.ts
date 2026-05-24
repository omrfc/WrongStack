import { ProviderError } from '../types/provider.js';
import { NETWORK_ERR_RE } from './regex-patterns.js';
import type { RetryPolicy } from '../types/retry-policy.js';

export class DefaultRetryPolicy implements RetryPolicy {
  shouldRetry(err: Error | ProviderError, attempt: number): boolean {
    if (err instanceof ProviderError) {
      if (!err.retryable) return false;
      return attempt < this.maxAttempts(err);
    }
    const msg = err.message ?? '';
    const isNetwork = NETWORK_ERR_RE.test(msg);
    if (isNetwork) return attempt < 2;
    return false;
  }

  maxAttempts(err: Error | ProviderError): number {
    if (err instanceof ProviderError) {
      if (err.status === 429) return 5;
      if (err.status === 529) return 3;
      if (err.status >= 500) return 3;
      return 0;
    }
    return 2;
  }

  delayMs(attempt: number): number {
    const base = 1000;
    const exp = base * 2 ** attempt;
    const jitter = Math.random() * base;
    return Math.min(30_000, exp + jitter);
  }
}
