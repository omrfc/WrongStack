/**
 * Office Map store — display preferences for the Fleet HQ map canvas.
 *
 * The map itself renders in the wide main area; these toggles are driven from
 * the OfficeMapSettingsPanel in the secondary panel. Persisted so a user's
 * preferred chrome (HUD / legend / minimap / controls / animation) survives
 * reloads.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type BackgroundStyle = 'dots' | 'lines' | 'cross' | 'none';

interface OfficeMapState {
  /** Real-time Session Stats HUD overlay (top-left). */
  showHud: boolean;
  /** Status + Connections legends (bottom corners). */
  showLegend: boolean;
  /** React Flow minimap (bottom-right). */
  showMinimap: boolean;
  /** React Flow zoom/fit controls (bottom-left). */
  showControls: boolean;
  /** Animate the dashed flow along active wires. */
  animateEdges: boolean;
  /** Background grid style. */
  background: BackgroundStyle;

  setShowHud: (v: boolean) => void;
  setShowLegend: (v: boolean) => void;
  setShowMinimap: (v: boolean) => void;
  setShowControls: (v: boolean) => void;
  setAnimateEdges: (v: boolean) => void;
  setBackground: (v: BackgroundStyle) => void;
}

export const useOfficeMapStore = create<OfficeMapState>()(
  persist(
    (set) => ({
      showHud: true,
      showLegend: true,
      showMinimap: true,
      showControls: true,
      animateEdges: true,
      background: 'dots',

      setShowHud: (v) => set({ showHud: v }),
      setShowLegend: (v) => set({ showLegend: v }),
      setShowMinimap: (v) => set({ showMinimap: v }),
      setShowControls: (v) => set({ showControls: v }),
      setAnimateEdges: (v) => set({ animateEdges: v }),
      setBackground: (v) => set({ background: v }),
    }),
    { name: 'wrongstack-officemap' },
  ),
);
