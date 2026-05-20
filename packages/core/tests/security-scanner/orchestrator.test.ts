import { describe, expect, it, vi } from 'vitest';
import type { Provider } from '../../src/types/provider.js';
import { SecurityScannerOrchestrator } from '../../src/security-scanner/orchestrator.js';
import type { RetryPolicy } from '../../src/types/retry-policy.js';
import type { ErrorHandler } from '../../src/types/error-handler.js';
import { ProviderError } from '../../src/types/provider.js';

const mockProvider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'test',
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: 'test response' }],
      stopReason: 'stop',
      usage: { input: 10, output: 20 },
    }),
    capabilities: { streaming: false },
    ...overrides,
  } as unknown as Provider);

const mockRetryPolicy = (): RetryPolicy =>
  ({
    shouldRetry: vi.fn().mockReturnValue(true),
    delayMs: vi.fn().mockReturnValue(10),
    maxAttempts: vi.fn().mockReturnValue(3),
  } as unknown as RetryPolicy);

const mockErrorHandler = (): ErrorHandler =>
  ({
    classify: vi.fn().mockReturnValue({ kind: 'rate_limit', retryable: true }),
    recover: vi.fn().mockResolvedValue(null),
  } as unknown as ErrorHandler);

describe('SecurityScannerOrchestrator', () => {
  describe('constructor', () => {
    it('accepts retryPolicy and errorHandler via constructor', () => {
      const retryPolicy = mockRetryPolicy();
      const errorHandler = mockErrorHandler();
      const orchestrator = new SecurityScannerOrchestrator(retryPolicy, errorHandler);
      expect(orchestrator).toBeDefined();
    });

    it('works without retryPolicy or errorHandler', () => {
      const orchestrator = new SecurityScannerOrchestrator();
      expect(orchestrator).toBeDefined();
    });
  });
});