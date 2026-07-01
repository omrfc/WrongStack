import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendConfirm = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ sendConfirm }),
}));

import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useUIStore } from '../../src/stores/ui-store';

describe('ConfirmDialog YOLO behavior', () => {
  beforeEach(() => {
    sendConfirm.mockClear();
    act(() => {
      useLocalPrefs.getState().set({ yolo: false });
      useUIStore.getState().hideConfirm();
    });
  });

  it('auto-approves an already-visible non-destructive prompt when YOLO turns on', async () => {
    render(<ConfirmDialog />);

    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm_1',
        toolName: 'batch_tool_use',
        input: { calls: [{ tool: 'grep', input: { pattern: 'x' } }] },
        suggestedPattern: 'batch_tool_use',
        riskTier: 'standard',
      });
    });

    expect(sendConfirm).not.toHaveBeenCalled();

    act(() => {
      useLocalPrefs.getState().set({ yolo: true });
    });

    await waitFor(() => {
      expect(sendConfirm).toHaveBeenCalledWith('confirm_1', 'yes');
    });
    expect(useUIStore.getState().showConfirmDialog).toBe(false);
  });

  it('keeps destructive prompts visible when YOLO turns on', async () => {
    render(<ConfirmDialog />);

    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm_2',
        toolName: 'bash',
        input: { command: 'rm -rf /' },
        suggestedPattern: 'rm -rf /',
        decisionSource: 'yolo_destructive',
        riskTier: 'destructive',
      });
      useLocalPrefs.getState().set({ yolo: true });
    });

    await waitFor(() => {
      expect(useUIStore.getState().showConfirmDialog).toBe(true);
    });
    expect(sendConfirm).not.toHaveBeenCalled();
  });
});
