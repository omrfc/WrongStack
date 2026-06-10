import { useMemo } from 'react';
import type { Action, State } from '../app-reducer.js';

export interface UseOverlayTogglesOptions {
  /** Live state, used to decide which other overlays/panels to close. */
  state: State;
  /** Reducer dispatch. */
  dispatch: React.Dispatch<Action>;
}

export interface UseOverlayTogglesResult {
  /** Toggle the F2/Ctrl+F fleet monitor. */
  toggleFleetOverlay: () => void;
  /** Toggle the F3/Ctrl+G agents monitor. */
  toggleAgentsOverlay: () => void;
  /** Toggle the F4/Ctrl+T worktree monitor. */
  toggleWorktreeOverlay: () => void;
  /** Toggle the F6 todos monitor. */
  toggleTodosOverlay: () => void;
  /** Open the F5 settings picker (closes other overlays first). */
  openSettingsOverlay: () => void;
  /** Close the F5 settings picker. */
  closeSettingsOverlay: () => void;
  /** Toggle the F7 queue panel (closes other overlays first when opening). */
  toggleQueuePanel: () => void;
  /** Toggle the F8 process-list overlay (closes other overlays first when opening). */
  toggleProcessList: () => void;
  /** Toggle the F9 goal panel (closes other overlays first when opening). */
  toggleGoalPanel: () => void;
}

/**
 * Overlay-mutex helpers. The TUI shows one dashboard at a time, so each
 * "open" path first closes the others (F2 fleet, F3 agents, F4 worktree,
 * F6 todos, F7 queue, F8 process list, F9 goal, settings). Esc closes
 * whichever is open (see handleKey).
 *
 * Implementation note: each helper inlines its own `closeOthers()` rather
 * than calling a shared `closeOtherOverlays(exclude)`. This avoids the
 * trap of trying to encode the "which panel is currently opening" state
 * in a string key, and keeps each helper a one-glance summary of the
 * "close these, then open that" sequence. There is one shared helper,
 * `openSettingsOverlay`, used by F5 and Ctrl+S.
 */
export function useOverlayToggles({
  state,
  dispatch,
}: UseOverlayTogglesOptions): UseOverlayTogglesResult {
  return useMemo(
    () => ({
      toggleFleetOverlay: () => {
        if (state.monitorOpen) {
          dispatch({ type: 'toggleMonitor' });
          return;
        }
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleMonitor' });
      },
      toggleAgentsOverlay: () => {
        if (state.agentsMonitorOpen) {
          dispatch({ type: 'toggleAgentsMonitor' });
          return;
        }
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleAgentsMonitor' });
      },
      toggleWorktreeOverlay: () => {
        if (state.worktreeMonitorOpen) {
          dispatch({ type: 'worktreeMonitorToggle' });
          return;
        }
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'worktreeMonitorToggle' });
      },
      toggleTodosOverlay: () => {
        if (state.todosMonitorOpen) {
          dispatch({ type: 'toggleTodosMonitor' });
          return;
        }
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleTodosMonitor' });
      },
      openSettingsOverlay: () => {
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      },
      closeSettingsOverlay: () => {
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      },
      toggleQueuePanel: () => {
        if (state.queuePanelOpen) {
          dispatch({ type: 'toggleQueuePanel' });
          return;
        }
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleQueuePanel' });
      },
      toggleProcessList: () => {
        if (state.processListOpen) {
          dispatch({ type: 'toggleProcessList' });
          return;
        }
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleProcessList' });
      },
      toggleGoalPanel: () => {
        if (state.goalPanelOpen) {
          dispatch({ type: 'toggleGoalPanel' });
          return;
        }
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.processListOpen) dispatch({ type: 'toggleProcessList' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleGoalPanel' });
      },
    }),
    [state, dispatch],
  );
}
