import { useCallback, useEffect } from 'react';
import type { QueueStore, SlashCommandRegistry } from '@wrongstack/core';
import type { Action, State } from '../app-reducer.js';
import type { Settings, QueueItem } from '../app-state.js';
import { createQueueSlashCommand } from '../queue-slash.js';

export interface UseQueueManagerOptions {
  /** Optional persistent store — absent => in-memory only (no crash recovery). */
  queueStore?: QueueStore | undefined;
  /** Called on every queue change so the host learns what's waiting. */
  onQueueChange?: ((items: string[]) => void) | undefined;
  /** Slash registry to register the /queue command. */
  slashRegistry: SlashCommandRegistry;
  /** Live state snapshot (ref, not render-state) for slash command closures. */
  stateRef: React.MutableRefObject<State>;
  dispatch: React.Dispatch<Action>;
  /** Settings access for persisting the mid-run send-mode picker toggle. */
  getSettings?: (() => Settings) | undefined;
  saveSettings?:
    | ((settings: Settings) => string | Promise<string | null> | null)
    | undefined;
  /** Live mirror of the mid-run send-mode picker enabled flag. */
  midRunSendPickerRef: React.MutableRefObject<boolean>;
}

/**
 * Manages the TUI message queue: rehydration from persistent store,
 * persistence on every change, host mirroring, and the /queue slash
 * command. All side-effect wiring extracted from app.tsx.
 */
export function useQueueManager({
  queueStore,
  onQueueChange,
  slashRegistry,
  stateRef,
  dispatch,
  getSettings,
  saveSettings,
  midRunSendPickerRef,
}: UseQueueManagerOptions): void {
  // ── Rehydrate persisted queue on mount ──────────────────────────────
  useEffect(() => {
    if (!queueStore) return;
    let cancelled = false;
    queueStore
      .read()
      .then((items: QueueItem[]) => {
        if (cancelled || items.length === 0) return;
        for (const item of items) {
          dispatch({
            type: 'enqueue',
            item: { displayText: item.displayText, blocks: item.blocks },
          });
        }
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `Restored ${items.length} queued message${items.length === 1 ? '' : 's'} from a previous run.`,
          },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStore]);

  // ── Persist queue on every change ──────────────────────────────────
  useEffect(() => {
    if (!queueStore) return;
    const raw = stateRef.current.queue.map(
      ({ displayText, blocks }: { displayText: string; blocks: unknown[] }) => ({
        displayText,
        blocks,
      }),
    );
    queueStore.write(raw).catch(() => undefined);
  }, [stateRef.current.queue, queueStore, stateRef]);

  // ── Mirror queue to host on every change ───────────────────────────
  useEffect(() => {
    onQueueChange?.(stateRef.current.queue.map((q) => q.displayText));
  }, [stateRef.current.queue, onQueueChange, stateRef]);

  // ── Register /queue slash command ──────────────────────────────────
  useEffect(() => {
    const cmd = createQueueSlashCommand({
      getQueue: () => stateRef.current.queue,
      clear: () => dispatch({ type: 'queueClear' }),
      deleteAt: (positions) => dispatch({ type: 'queueDelete', positions }),
      getPickerEnabled: () => midRunSendPickerRef.current,
      setPickerEnabled: (enabled) => {
        midRunSendPickerRef.current = enabled;
        const cur = getSettings?.();
        if (cur && saveSettings) {
          Promise.resolve(saveSettings({ ...cur, midRunSendPicker: enabled })).catch(() => {});
        }
      },
    });
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('queue');
    };
  }, [slashRegistry, stateRef, dispatch, getSettings, saveSettings, midRunSendPickerRef]);
}
