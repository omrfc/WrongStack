import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendConfirm = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ sendConfirm }),
}));

vi.mock('@/lib/chime', () => ({
  playCompletionChime: vi.fn(),
  playPermissionChime: vi.fn(),
}));

vi.mock('@/lib/notify', () => ({
  ensureNotificationPermission: vi.fn(),
  notifyIfHidden: vi.fn(),
}));

vi.mock('@/lib/favicon', () => ({
  setFaviconStatus: vi.fn(),
}));

import { handleToolConfirmNeeded } from '../../src/hooks/ws-handlers/chat-handlers';
import { handlePrefsUpdated } from '../../src/hooks/ws-handlers/misc-handlers';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useSessionStore } from '../../src/stores/session-store';
import { useUIStore } from '../../src/stores/ui-store';

function fireConfirm(payload: Record<string, unknown>) {
  handleToolConfirmNeeded({ type: 'tool.confirm_needed', payload } as never);
}

describe('handleToolConfirmNeeded', () => {
  beforeEach(() => {
    sendConfirm.mockClear();
    useLocalPrefs.getState().set({ yolo: false });
    useUIStore.getState().hideConfirm();
    useSessionStore.getState().setSession({
      id: 'sess_1',
      title: 'test',
      startedAt: Date.now(),
      messages: [],
    });
  });

  it('shows the approval dialog when YOLO is off', () => {
    fireConfirm({
      sessionId: 'sess_1',
      id: 'confirm_1',
      toolName: 'batch_tool_use',
      input: { calls: [] },
      suggestedPattern: 'batch_tool_use',
      riskTier: 'standard',
    });

    expect(sendConfirm).not.toHaveBeenCalled();
    expect(useUIStore.getState().showConfirmDialog).toBe(true);
    expect(useUIStore.getState().confirmInfo?.id).toBe('confirm_1');
  });

  it('auto-approves non-destructive stale prompts when YOLO is on', () => {
    useLocalPrefs.getState().set({ yolo: true });

    fireConfirm({
      sessionId: 'sess_1',
      id: 'confirm_2',
      toolName: 'batch_tool_use',
      input: { calls: [{ tool: 'grep', input: { pattern: 'x' } }] },
      suggestedPattern: 'batch_tool_use',
      riskTier: 'standard',
    });

    expect(sendConfirm).toHaveBeenCalledWith('confirm_2', 'yes');
    expect(useUIStore.getState().showConfirmDialog).toBe(false);
  });

  it('keeps destructive prompts visible even when YOLO is on', () => {
    useLocalPrefs.getState().set({ yolo: true });

    fireConfirm({
      sessionId: 'sess_1',
      id: 'confirm_3',
      toolName: 'bash',
      input: { command: 'rm -rf /' },
      suggestedPattern: 'rm -rf /',
      decisionSource: 'yolo_destructive',
      riskTier: 'destructive',
    });

    expect(sendConfirm).not.toHaveBeenCalled();
    expect(useUIStore.getState().showConfirmDialog).toBe(true);
    expect(useUIStore.getState().confirmInfo?.riskTier).toBe('destructive');
  });
});

describe('handlePrefsUpdated confirm visibility', () => {
  beforeEach(() => {
    sendConfirm.mockClear();
    useLocalPrefs.getState().set({ yolo: false });
    useUIStore.getState().hideConfirm();
  });

  it('hides a non-destructive visible confirm when YOLO turns on', () => {
    useUIStore.getState().showConfirm({
      id: 'confirm_safe',
      toolName: 'batch_tool_use',
      input: { calls: [] },
      suggestedPattern: 'batch_tool_use',
      riskTier: 'standard',
    });

    handlePrefsUpdated({ type: 'prefs.updated', payload: { yolo: true } } as never);

    expect(useUIStore.getState().showConfirmDialog).toBe(false);
    expect(useUIStore.getState().confirmInfo).toBeNull();
  });

  it('keeps a destructive visible confirm when YOLO turns on', () => {
    useUIStore.getState().showConfirm({
      id: 'confirm_destructive',
      toolName: 'bash',
      input: { command: 'rm -rf /' },
      suggestedPattern: 'rm -rf /',
      decisionSource: 'yolo_destructive',
      riskTier: 'destructive',
    });

    handlePrefsUpdated({ type: 'prefs.updated', payload: { yolo: true } } as never);

    expect(useUIStore.getState().showConfirmDialog).toBe(true);
    expect(useUIStore.getState().confirmInfo?.id).toBe('confirm_destructive');
  });
});
