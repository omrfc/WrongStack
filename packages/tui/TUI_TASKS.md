# TUI Shortcut and Panel Cleanup Tasks

## Goal

Keep the TUI shortcut registry, help overlay, README documentation, and panel behavior aligned so adding or changing a panel does not create shortcut drift.

## Tasks

1. Extract shared F-key panel metadata
   - Create a single source of truth for F1-F12 panel labels, descriptions, actions, and documentation text.
   - Use it from the F-key picker and HelpOverlay instead of duplicating labels.
   - Keep special aliases such as Ctrl+F/F2, Ctrl+G/F3, and Ctrl+T/F4 represented clearly.

2. Harden F-key launcher behavior
   - Ensure every advertised F-key can be opened directly from the keyboard and from the `/f` picker.
   - Handle actions that require payloads, such as `statuslineOpen`, without unsafe casts.
   - Add focused tests for F5 plan panel and F12 status line picker routing.

3. Reduce duplicated panel-close logic
   - Route panel opening through reducer actions where possible.
   - Remove duplicated “close other panels” code from `app.tsx` and overlay helpers.
   - Preserve the current mutual-exclusion behavior for F2-F12 panels.

4. Update user-facing documentation
   - Keep `README.md`, HelpOverlay, and the F-key picker synchronized.
   - Document direct F-key shortcuts, Ctrl aliases, `/f`, `/settings`, `/project`, and `/statusline`.
   - Add drift tests where source-readable docs can be tested reliably.

5. Improve panel-specific shortcut help
   - Add panel-local help hints for panels that own keyboard input, especially Process List and Sessions.
   - Make it clear when the chat input remains live behind a panel and when a panel is modal.

6. Add regression coverage
   - Cover F-key metadata alignment.
   - Cover `/f` launching special-case panels.
   - Cover Esc close behavior and panel mutual exclusion for newly added paths.

## Verification checklist

- Run Biome format on touched files.
- Run Biome lint on touched source and tests.
- Run focused Vitest tests for HelpOverlay, F-key handling, and reducer panel behavior.
- Run `packages/tui/tsconfig.json` typecheck.

## Notes

The working tree is shared with other active agents. Avoid staging or committing unrelated changes. Before committing, inspect `git status` and stage only files changed for these tasks.
