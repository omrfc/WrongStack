// @vitest-environment jsdom
// These helpers touch `window`/`document` — the package-local vitest config
// runs all webui tests under jsdom, but the ROOT config (pnpm test) defaults
// to the node environment; this pragma keeps the file green from both entries.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type NotificationRecord = {
  title: string;
  options?: NotificationOptions;
  closed: boolean;
};

function installNotificationMock(permission: NotificationPermission) {
  const records: NotificationRecord[] = [];

  class MockNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    onclick: (() => void) | null = null;
    private record: NotificationRecord;

    constructor(title: string, options?: NotificationOptions) {
      this.record = { title, options, closed: false };
      records.push(this.record);
    }

    close() {
      this.record.closed = true;
    }
  }

  vi.stubGlobal('Notification', MockNotification);
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
  return { MockNotification, records };
}

describe('notification helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
  });

  it('requests permission lazily and caches the result', async () => {
    const { MockNotification } = installNotificationMock('default');
    const { ensureNotificationPermission } = await import('@/lib/notify');

    await expect(ensureNotificationPermission()).resolves.toBe('granted');
    await expect(ensureNotificationPermission()).resolves.toBe('granted');
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('does not notify while the tab is visible', async () => {
    const { records } = installNotificationMock('granted');
    const { notifyIfHidden } = await import('@/lib/notify');

    notifyIfHidden('Done', 'Visible tab');

    expect(records).toHaveLength(0);
  });

  it('creates a tagged notification only when hidden and granted', async () => {
    const { records } = installNotificationMock('granted');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    const { notifyIfHidden } = await import('@/lib/notify');

    notifyIfHidden('Approval needed', 'Tool is waiting', 'wrongstack-confirm');

    expect(records).toEqual([
      expect.objectContaining({
        title: 'Approval needed',
        options: expect.objectContaining({
          body: 'Tool is waiting',
          tag: 'wrongstack-confirm',
          requireInteraction: true,
        }),
      }),
    ]);
  });
});
