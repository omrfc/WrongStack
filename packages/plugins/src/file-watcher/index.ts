/**
 * file-watcher plugin — Watches project files and triggers actions on changes.
 *
 * Tools registered:
 * - watch_start: Start watching paths for file changes
 * - watch_stop: Stop a watch by ID
 * - watch_list: List all active watches
 */
import type { Plugin } from '@wrongstack/core';
import { watch as fsWatch } from 'node:fs';
import * as path from 'node:path';

const API_VERSION = '^0.1.10';

interface WatchHandle {
  id: string;
  paths: string[];
  recursive: boolean;
  events: string[];
  watcher: { close: () => void };
  createdAt: string;
}

let watchIdCounter = 0;

function nextId(): string {
  return `watch_${++watchIdCounter}_${Date.now().toString(36)}`;
}

// Module-level state, shared between `setup` and `teardown`.
//
// Why module-level? The Plugin interface in @wrongstack/core does not
// thread state from `setup` → `teardown`. Keeping `watches` and
// `debounceTimers` inside the setup closure made both Maps invisible
// to teardown — which is why the previous teardown was a documented
// no-op that leaked every fs.FSWatcher and every debounce setTimeout
// (H1 audit, 2026-06-03). With stable Map identity at module scope
// teardown can finally close handles and clear timers. The contents
// are reset in setup (idempotent re-init) and freed in teardown.
const watches = new Map<string, WatchHandle>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'file-watcher',
  version: '0.1.0',
  description: 'Watches project files and emits events when changes occur (add, change, delete)',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    debounceMs: 500,
    watchOnStartup: [],
    autoUnwatchOnExit: true,
    autoIndex: false,
    indexProjectRoot: '',
  },
  configSchema: {
    type: 'object',
    properties: {
      debounceMs: { type: 'number', default: 500 },
      watchOnStartup: { type: 'array', items: { type: 'string' }, default: [] },
      autoUnwatchOnExit: { type: 'boolean', default: true },
      autoIndex: {
        type: 'boolean',
        default: false,
        description: 'When true, automatically reindex changed .ts/.tsx/.js/.jsx files via codebase-index (incremental)',
      },
      indexProjectRoot: {
        type: 'string',
        default: '',
        description: 'Project root directory for the indexer. Defaults to cwd when empty.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init: on plugin reload, close any leftover watches
    // and clear any pending debounce timers before re-populating. The
    // Maps live at module scope so teardown can reach them.
    for (const handle of watches.values()) {
      try {
        handle.watcher.close();
      } catch {
        /* ignore — handle may already be closed */
      }
    }
    watches.clear();
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();

    const debounceMs = (api.config.extensions?.['file-watcher'] as Record<string, unknown>)?.['debounceMs'] as number ?? 500;

    function debounceEvent(key: string, fn: () => void, ms: number): void {
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key);
        fn();
      }, ms));
    }

    const autoIndex = (api.config.extensions?.['file-watcher'] as Record<string, unknown>)?.['autoIndex'] as boolean ?? false;
    const indexProjectRoot = (api.config.extensions?.['file-watcher'] as Record<string, unknown>)?.['indexProjectRoot'] as string ?? '';

    const INDEXABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

    function isIndexableFile(filePath: string): boolean {
      return INDEXABLE_EXTENSIONS.has(path.extname(filePath));
    }

    function safeWatchDir(dirPath: string, recursive: boolean, handle: WatchHandle): void {
      try {
        const watcher = fsWatch(dirPath, { recursive }, (eventType, filename) => {
          if (!filename) return;
          const fullPath = `${dirPath}/${filename}`;
          const key = `${handle.id}:${fullPath}:${eventType}`;
          debounceEvent(key, () => {
            api.emitCustom('file-watcher:changed', {
              watchId: handle.id,
              path: fullPath,
              event: eventType,
              filename,
              timestamp: new Date().toISOString(),
            });
            api.metrics.counter('file_change', 1, { event: eventType ?? 'unknown' });
            api.log.debug(`file-watcher: ${eventType} ${fullPath} (watch=${handle.id})`);

            if (autoIndex && isIndexableFile(fullPath)) {
              debounceEvent(`index:${fullPath}`, async () => {
                try {
                  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                  // @ts-ignore — runtime resolution; type-only import not visible to DTS worker
                  const { runIndexer } = await import('@wrongstack/tools/codebase-index/index.js');
                  const root = indexProjectRoot || dirPath;
                  const fakeAppend = async () => { /* noop */ };
                  const fakeClose = async () => { /* noop */ };
                  const fakeRecordFileChange = () => { /* noop */ };
                  const ctx = {
                    projectRoot: root,
                    cwd: root,
                    messages: [],
                    todos: [],
                    readFiles: new Set(),
                    fileMtimes: new Map(),
                    session: { id: 'fw', append: fakeAppend, close: fakeClose, recordFileChange: fakeRecordFileChange },
                  } as unknown as Parameters<typeof runIndexer>[0];
                  await runIndexer(ctx, { projectRoot: root, files: [fullPath] });
                  api.metrics.counter('index_file', 1);
                  api.log.debug(`file-watcher: auto-index triggered for ${fullPath}`);
                } catch (err) {
                  api.log.warn(`file-watcher: auto-index failed for ${fullPath}: ${err}`);
                }
              }, debounceMs);
            }
          }, debounceMs);
        });

        watcher.on('error', (err: unknown) => {
          api.log.warn(`file-watcher: error on ${dirPath}: ${err}`);
        });

        handle.watcher = watcher;
      } catch (err) {
        api.log.warn(`file-watcher: could not watch ${dirPath}: ${err}`);
      }
    }

    // --- watch_start ---
    api.tools.register({
      name: 'watch_start',
      description: 'Start watching one or more file paths for changes (add, change, delete). Returns a watch ID for stopping the watch later.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'File or directory paths to watch',
          },
          events: {
            type: 'array',
            items: { type: 'string' },
            default: ['change', 'add', 'delete'],
            description: 'Event types to watch for',
          },
          recursive: {
            type: 'boolean',
            default: true,
            description: 'Watch directories recursively',
          },
        },
        required: ['paths'],
      },
      permission: 'confirm',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const rawPaths = input['paths'];
        if (!rawPaths || (typeof rawPaths !== 'object') || !Array.isArray(rawPaths)) {
          return { ok: false, error: 'paths must be an array of file/directory paths', watchId: null };
        }
        const paths = rawPaths as string[];
        if (paths.length === 0) {
          return { ok: false, error: 'paths array is empty — provide at least one path', watchId: null };
        }
        const events = (input['events'] as string[] | undefined) ?? ['change', 'add', 'delete'];
        const recursive = (input['recursive'] as boolean | undefined) ?? true;

        const id = nextId();
        const handle: WatchHandle = {
          id,
          paths,
          recursive,
          events,
          watcher: { close: () => {} },
          createdAt: new Date().toISOString(),
        };

        for (const p of paths) {
          safeWatchDir(p, recursive, handle);
        }

        watches.set(id, handle);

        api.metrics.gauge('active_watches', watches.size);

        return {
          ok: true,
          watchId: id,
          paths,
          events,
          recursive,
          message: `Started watching ${paths.length} path(s). Use watch_stop to cancel.`,
        };
      },
    });

    // --- watch_stop ---
    api.tools.register({
      name: 'watch_stop',
      description: 'Stop a file watch by its ID. Releases all resources.',
      inputSchema: {
        type: 'object',
        properties: {
          watchId: { type: 'string', description: 'Watch ID returned by watch_start' },
        },
        required: ['watchId'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const watchId = input['watchId'] as string;
        const handle = watches.get(watchId);

        if (!handle) {
          return { ok: false, error: `No active watch with ID: ${watchId}` };
        }

        try {
          handle.watcher.close();
        } catch {
          // ignore
        }

        watches.delete(watchId);
        api.metrics.gauge('active_watches', watches.size);

        return {
          ok: true,
          watchId,
          message: `Stopped watch ${watchId}. ${watches.size} watch(es) remaining.`,
        };
      },
    });

    // --- watch_list ---
    api.tools.register({
      name: 'watch_list',
      description: 'List all currently active file watches with their IDs, paths, and creation times.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        const list = Array.from(watches.values()).map((w) => ({
          id: w.id,
          paths: w.paths,
          events: w.events,
          recursive: w.recursive,
          createdAt: w.createdAt,
          age: `${Date.now() - new Date(w.createdAt).getTime()}ms`,
        }));

        return {
          ok: true,
          count: list.length,
          watches: list,
        };
      },
    });

    api.log.info('file-watcher plugin loaded', { version: '0.1.0' });
  },

  teardown(api) {
    // Close every chokidar.FSWatcher handle and clear every debounce
    // setTimeout. The previous implementation was a documented no-op
    // (the watches Map was in the setup closure and unreachable from
    // teardown), so the only thing that ever cleaned these up was
    // process exit — which is fine for a one-shot run, but leaks
    // during a hot-reload loop or a long-lived REPL session (H1
    // audit, 2026-06-03). With module-level Maps we can finally
    // reach the resources and free them.
    for (const handle of watches.values()) {
      try {
        handle.watcher.close();
      } catch {
        /* ignore — handle may already be closed */
      }
    }
    watches.clear();
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    api.log.info('file-watcher: teardown complete', {
      closed: 0, // recorded for log symmetry; actual count cleared above
    });
  },
};

export default plugin;