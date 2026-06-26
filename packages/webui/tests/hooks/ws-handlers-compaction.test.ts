import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send: vi.fn() }),
}));

vi.mock('@/components/Toaster', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { useChatStore } from '../../src/stores/chat-store';

function fire(type: string, payload: Record<string, unknown>) {
  WS_HANDLERS[type]?.({ type, payload } as never);
}

describe('compaction ws-handlers', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
    useChatStore.getState().setLoading(false);
    vi.clearAllMocks();
  });

  it('uses input budget load when compaction failure carries budget details', () => {
    fire('compaction.failed', {
      message: 'context still too large',
      level: 'hard',
      tokens: 1400,
      maxContext: 2000,
      fatal: true,
      budget: {
        inputTokens: 1400,
        availableInputTokens: 1000,
        load: 1.4,
      },
    });

    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Compaction failed at hard (100% input budget): context still too large',
      isError: true,
    });
  });

  it('clamps legacy compaction failure context load to 100 percent', () => {
    fire('compaction.failed', {
      message: 'legacy failure',
      level: 'soft',
      tokens: 1200,
      maxContext: 1000,
      fatal: false,
    });

    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Compaction failed at soft (100% context): legacy failure',
      isError: false,
    });
  });
});
