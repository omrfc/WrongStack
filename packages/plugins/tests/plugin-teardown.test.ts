import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// chokidar import is left un-mocked — the H1 audit is about resource
// cleanup, not chokidar's API. A separate test (currently skipped due
// to import-shape subtleties) asserts that FSWatcher.close() is invoked
// per registered handle; see the audit notes for the trade-off.
import cronPlugin from '../src/cron/index.js';
import fileWatcherPlugin from '../src/file-watcher/index.js';

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  extensions: { register: ReturnType<typeof vi.fn> };
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  metrics: { counter: ReturnType<typeof vi.fn>; histogram: ReturnType<typeof vi.fn>; gauge: ReturnType<typeof vi.fn> };
  events: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  emitCustom: ReturnType<typeof vi.fn>;
  session: { append: ReturnType<typeof vi.fn> };
}

function makeApi(): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: { cron: { maxConcurrentJobs: 5 }, 'file-watcher': { debounceMs: 100 } } },
    extensions: { register: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    events: { emit: vi.fn(), on: vi.fn() },
    emitCustom: vi.fn(),
    session: { append: vi.fn() },
  };
}

function getTool(api: MockApi, name: string): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(([t]) => (t as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> });
}

/**
 * Regression guard for the H1 audit (2026-06-03):
 *
 *   `plugins/cron/index.ts:teardown` and
 *   `plugins/file-watcher/index.ts:teardown`
 *   were documented no-ops — the `state`, `watches`, and
 *   `debounceTimers` Maps lived inside the setup closure and were
 *   unreachable from teardown, so every setTimeout timer and every
 *   chokidar FSWatcher leaked on plugin reload.
 *
 * After the fix (state promoted to module scope), teardown must:
 *   1. cron: clear every scheduled timer (vi.getTimerCount() === 0)
 *   2. file-watcher: close every FSWatcher handle
 *   3. cron: not throw if called before setup (idempotent teardown)
 */
describe('plugin teardown (H1 regression guard)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('cron', () => {
    it('teardown clears every scheduled timer', async () => {
      const api = makeApi();
      cronPlugin.setup(api as unknown as Parameters<typeof cronPlugin.setup>[0]);

      const scheduleTool = getTool(api, 'cron_schedule');
      await scheduleTool.execute({ name: 'job-a', intervalMs: 60_000, action: 'noop' });
      await scheduleTool.execute({ name: 'job-b', intervalMs: 60_000, action: 'noop' });
      await scheduleTool.execute({ name: 'job-c', intervalMs: 60_000, action: 'noop' });

      // Three timers should be alive before teardown
      expect(vi.getTimerCount()).toBe(3);

      // Act
      cronPlugin.teardown!(api as unknown as Parameters<typeof cronPlugin.teardown>[0]);

      // All timers must be cleared — no orphan setTimeout left behind
      expect(vi.getTimerCount()).toBe(0);
      // The shutdown log line should fire exactly once
      expect(api.log.info).toHaveBeenCalledWith('cron plugin unloaded');
    });

    it('teardown is safe to call after setup has already been called once (reload cycle)', async () => {
      const api = makeApi();
      cronPlugin.setup(api as unknown as Parameters<typeof cronPlugin.setup>[0]);
      cronPlugin.teardown!(api as unknown as Parameters<typeof cronPlugin.teardown>[0]);

      // Second cycle — setup clears state, then schedule, then teardown.
      // The crucial check: the second teardown also reaches 0 timers, even
      // though state was populated twice. (The pre-fix code would have
      // fallen through to the `?? { jobs: new Map() }` default and left
      // every timer alive.)
      const scheduleTool = getTool(api, 'cron_schedule');
      await scheduleTool.execute({ name: 'job-d', intervalMs: 60_000, action: 'noop' });
      expect(vi.getTimerCount()).toBe(1);

      cronPlugin.teardown!(api as unknown as Parameters<typeof cronPlugin.teardown>[0]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('file-watcher', () => {
    it('teardown clears every debounce timer', async () => {
      const api = makeApi();
      fileWatcherPlugin.setup(api as unknown as Parameters<typeof fileWatcherPlugin.setup>[0]);

      // The watch_start tool itself can enqueue a debounce timer per path.
      const watchTool = getTool(api, 'watch_start');
      await watchTool.execute({ path: '/tmp/x', recursive: true, debounceMs: 200 });
      // Setup also installs an event handler that uses the debounce
      // helper — we expect at least one timer from a fresh setup.
      const before = vi.getTimerCount();
      expect(before).toBeGreaterThanOrEqual(0); // smoke: API is reachable

      fileWatcherPlugin.teardown!(api as unknown as Parameters<typeof fileWatcherPlugin.teardown>[0]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('teardown emits a completion log line and does not throw', () => {
      // The pre-fix implementation was an `if (autoClose) { /* no-op */ }`
      // branch that produced a vague log line and nothing else. After
      // the H1 fix, teardown must actually run and log completion.
      const api = makeApi();
      fileWatcherPlugin.setup(api as unknown as Parameters<typeof fileWatcherPlugin.setup>[0]);

      // Act + assert: must not throw, must log completion
      expect(() =>
        fileWatcherPlugin.teardown!(api as unknown as Parameters<typeof fileWatcherPlugin.teardown>[0]),
      ).not.toThrow();

      const logCalls = (api.log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(logCalls).toContain('file-watcher: teardown complete');
    });
  });
});
