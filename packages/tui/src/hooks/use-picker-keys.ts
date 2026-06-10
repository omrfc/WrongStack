/**
 * Picker key dispatch.
 *
 * The picker dispatch is a closed dispatch table where each picker checks
 * `state.<picker>.open` and either handles the key (returning `true`) or
 * falls through (returning `false`). The hook returns a single function
 * `tryPickerKey(input, key, isEnter)` that the caller's `handleKey` invokes
 * *before* its non-picker dispatch and bails on `true`.
 *
 * Currently handles the **Model picker** (two-step: provider → model).
 * Other pickers (autonomy, resume, settings, slash, file) are still
 * inlined in `handleKey` — they're good candidates for follow-up
 * extractions in the same pattern.
 */

import { useCallback } from 'react';
import type { Action, State } from '../app-reducer.js';
import type { KeyEvent } from '../components/input.js';

export interface PickerKeysHost {
  /** Live reducer state. The picker is identified by `state.modelPicker.open`. */
  state: State;
  /** Reducer dispatch. */
  dispatch: React.Dispatch<Action>;
  /** Agent context `maxContext` — read after a successful model switch. */
  agentCtxMaxContext: number;
  /** Ref-like double-tap debounce for Enter (avoids \\r\\n double-submits). */
  lastEnterAtRef: { current: number } | React.RefObject<number>;
  /** Ref-like re-entrancy guard for input handling. */
  inputGateRef: { current: boolean } | React.RefObject<boolean>;
  /** Live model switch. Returns `null`/`undefined` on success or a hint string. */
  switchProviderAndModel: ((providerId: string, modelId: string) => string | null) | undefined;
  /** Setter for the live provider mirror (status bar). Accepts the wider
   *  `Dispatch<SetStateAction<string>>` shape so the React state setters
   *  the caller already has can be passed directly without wrapping. */
  setLiveProvider: React.Dispatch<React.SetStateAction<string>> | undefined;
  /** Setter for the live model mirror (status bar). */
  setLiveModel: React.Dispatch<React.SetStateAction<string>> | undefined;
  /** Setter for the active max context (status bar context chip). */
  setActiveMaxContext: React.Dispatch<React.SetStateAction<number | undefined>> | undefined;
}

const ENTER_DOUBLE_TAP_MS = 50;

/**
 * Try to dispatch the key against any open picker. Returns `true` if a picker
 * handled the key (caller MUST stop dispatching), `false` otherwise.
 *
 * `isEnter` is passed per-call (not via the hook) because it is derived from
 * `key.return || input === '\r' || input === '\n' || clickConfirm` and the
 * latter two are recomputed inside `handleKey` from the current picker-open
 * state. The hook holds the *stable* host bits; the per-call bits stay in
 * `handleKey`.
 */
export function usePickerKeys(
  host: PickerKeysHost,
): (input: string, key: KeyEvent, isEnter: boolean) => boolean {
  return useCallback(
    (input: string, key: KeyEvent, isEnter: boolean): boolean => {
      const { state, dispatch } = host;

      // ── Model picker (two-step: provider → model) ──────────────
      if (state.modelPicker.open) {
        if (key.escape) {
          if (state.modelPicker.step === 'model') {
            dispatch({ type: 'modelPickerBack' });
          } else {
            dispatch({ type: 'modelPickerClose' });
          }
          return true;
        }
        if (key.mouse?.kind === 'wheel') {
          dispatch({ type: 'modelPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
          return true;
        }
        if (key.upArrow) {
          dispatch({ type: 'modelPickerMove', delta: -1 });
          return true;
        }
        if (key.downArrow) {
          dispatch({ type: 'modelPickerMove', delta: 1 });
          return true;
        }
        // Step 2: type-to-search — printable characters append to the filter.
        if (state.modelPicker.step === 'model' && input && !key.return && !key.backspace) {
          dispatch({ type: 'modelPickerSearch', query: state.modelPicker.searchQuery + input });
          return true;
        }
        // Step 2: Backspace — delete last char from filter, or go back if empty.
        if (state.modelPicker.step === 'model' && key.backspace) {
          const q = state.modelPicker.searchQuery;
          if (q.length > 0) {
            dispatch({ type: 'modelPickerSearch', query: q.slice(0, -1) });
          } else {
            dispatch({ type: 'modelPickerBack' });
          }
          return true;
        }
        if (isEnter) {
          // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
          const now = Date.now();
          if (now - host.lastEnterAtRef.current < ENTER_DOUBLE_TAP_MS) return true;
          host.lastEnterAtRef.current = now;
          host.inputGateRef.current = true;
          try {
            if (state.modelPicker.step === 'provider') {
              const opt = state.modelPicker.providerOptions[state.modelPicker.selected];
              if (!opt) return true;
              dispatch({
                type: 'modelPickerPickProvider',
                providerId: opt.id,
                models: opt.models,
              });
              return true;
            }
            // step === 'model' → commit the switch (use filteredOptions for selected model)
            const providerId = state.modelPicker.pickedProviderId;
            const modelId = state.modelPicker.filteredOptions[state.modelPicker.selected];
            if (!providerId || !modelId) return true;
            const err = host.switchProviderAndModel?.(providerId, modelId);
            if (err) {
              dispatch({ type: 'modelPickerHint', text: err });
              return true;
            }
            host.setLiveProvider?.(providerId);
            host.setLiveModel?.(modelId);
            host.setActiveMaxContext?.(host.agentCtxMaxContext);
            dispatch({
              type: 'addEntry',
              entry: { kind: 'info', text: `Switched to ${providerId} / ${modelId}.` },
            });
            dispatch({ type: 'modelPickerClose' });
            return true;
          } finally {
            host.inputGateRef.current = false;
          }
        }
        // Any other key while picker is open: ignore.
        return true;
      }

      return false;
    },
    [host],
  );
}
