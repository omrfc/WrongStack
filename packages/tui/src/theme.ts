// Central TUI palette. Until now colors were hardcoded as Ink color names
// (`color="cyan"`, `borderColor="magenta"`, …) scattered across ~18
// components, so there was no single place to tune the look. This module is
// that place: semantic tokens whose *values* are the Ink color names already
// in use, so adopting it is a pure rename with zero visual change. Re-skinning
// later is then a one-line edit here that propagates everywhere.
//
// Values are Ink color names (https://github.com/vadimdemedes/ink#color) — any
// of the 16 ANSI names, `gray`, the *Bright variants, or a hex/rgb string.

export interface Theme {
  /** Primary accent — prompts, links, tool names, assistant label. */
  accent: string;
  /** USER: label + the user's own message text marker. */
  user: string;
  /** ASSISTANT: label. */
  assistant: string;
  /** Tool name / tool activity. */
  tool: string;
  /** Success states (✓, passing, added diff lines). */
  success: string;
  /** Warnings, queued items, the user-input label. */
  warn: string;
  /** Errors, failures, deleted diff lines, danger chips. */
  error: string;
  /** Muted/secondary text. `true` maps to Ink's `dimColor`; a color name also works. */
  dim: true | string;
  /** Default (quiet) border color for panels. */
  borderDefault: string;
  /** Active/attention border (confirm prompts, focused frames). */
  borderActive: string;
  /** Banner / brand accent. */
  brand: string;
  /** Per-monitor accent borders so each overlay has a distinct identity. */
  monitor: {
    fleet: string;
    agents: string;
    worktree: string;
    phase: string;
  };
  /** Diff add/delete background blocks (content highlight). */
  diffAddBg: string;
  diffDelBg: string;
}

// Single tuned dark palette. The values intentionally mirror the colors already
// hardcoded today (cyan/yellow/green/red/magenta), so the first adoption pass is
// visually identical. A second palette can be added later as a drop-in; we keep
// the shape (a `Theme`) ready for that without paying the tuning cost now.
export const theme: Theme = Object.freeze({
  accent: 'cyan',
  user: 'yellow',
  assistant: 'cyan',
  tool: 'cyan',
  success: 'green',
  warn: 'yellow',
  error: 'red',
  dim: true,
  borderDefault: 'gray',
  borderActive: 'yellow',
  brand: 'magenta',
  monitor: {
    fleet: 'cyan',
    agents: 'magenta',
    worktree: 'green',
    phase: 'cyan',
  },
  diffAddBg: 'greenBright',
  diffDelBg: 'redBright',
});
