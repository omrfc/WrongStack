import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { startPackageOutdatedWatcher } from '../../src/coordination/package-outdated-watcher.js';

describe('package-outdated-watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startPackageOutdatedWatcher', () => {
    it('returns a dispose function', () => {
      const dispose = startPackageOutdatedWatcher({
        mailbox: {
          query: async () => [],
          send: async () => {},
          ack: async () => {},
        } as any,
        packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
        onNotify: async () => {},
        onLog: () => {},
      });

      expect(typeof dispose).toBe('function');
      dispose();
    });

    it('calls onError when mailbox.query throws', async () => {
      const errors: unknown[] = [];
      const dispose = startPackageOutdatedWatcher({
        mailbox: {
          query: async () => {
            throw new Error('Query failed');
          },
          send: async () => {},
          ack: async () => {},
        } as any,
        packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
        pollIntervalMs: 999_999_999,
        onNotify: async () => {},
        onLog: () => {},
        onError: (err) => errors.push(err),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe('Query failed');

      dispose();
    });

    it('processes outdated packages and notifies authors', async () => {
      const notifications: Array<{ to: string; subject: string }> = [];

      // Simulate a tech-stack result message with outdated packages in table format
      const fakeMsg = {
        id: 'msg-1',
        from: 'tech-stack',
        body:
          '| Package | Current | Latest | Wanted | Manifest |\n' +
          '|---------|---------|--------|--------|----------|\n' +
          '| vitest | 0.9.0 | 1.2.3 | ^1.0.0 | package.json |\n',
        timestamp: new Date().toISOString(),
        type: 'result' as const,
      };

      const dispose = startPackageOutdatedWatcher({
        mailbox: {
          query: async () => [fakeMsg as any],
          ack: async () => {},
          send: async () => {},
        } as any,
        packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
        pollIntervalMs: 1,
        onNotify: async (msg) => {
          notifications.push({ to: msg.to, subject: msg.subject });
        },
        onLog: () => {},
      });

      // Advance timers enough to fire the initial pollOnce and the interval callback
      await vi.advanceTimersByTimeAsync(100);

      // Since we don't have the author recorded, it broadcasts to '*'
      expect(notifications.some((n) => n.to === '*')).toBe(true);
      // And it should mention the package name in the subject
      expect(notifications.some((n) => n.subject.includes('vitest'))).toBe(true);

      dispose();
    });
  });
});
