# TUI Keyboard Reference

> All key bindings for the WrongStack terminal UI. Key handling is layered:
> overlays and pickers (highest priority) claim their keys first; unclaimed
> keys fall through to the chat input (character movement, editing, history).

---

## Table of Contents

1. [Status-aware keys](#1-status-aware-keys)
2. [Pickers (modal overlays)](#2-pickers-modal-overlays)
3. [Monitor overlays](#3-monitor-overlays)
4. [Inline input editing](#4-inline-input-editing)
5. [Mouse interactions](#5-mouse-interactions)
6. [Enter/Tab special behavior](#6-entertab-special-behavior)
7. [Component-internal keys](#7-component-internal-keys)

---

## 1. Status-aware keys

These keys behave differently depending on whether an LLM request is running.

### Esc — interrupt

| Agent status | Effect |
|---|---|
| `idle` | Falls through to normal text handling (inserts nothing — Esc is a terminal control char) |
| `running` / `aborting` | When `confirmExit` is **on** → shows confirmation dialog. When `confirmExit` is **off** → interrupts immediately, aborts subagents, drops queue, shows "↯ Interrupted" banner |
| `running` + `confirmExit` dialog shown | **y** or **Enter** = confirm interrupt; **n** or **Esc** = cancel, let agent continue |

### `?` — help overlay

Opens the help overlay when **all** of these are true:
- Input buffer is empty
- No picker or overlay is open
- No Ctrl/Meta modifier held

### Enter — submit

| Condition | Effect |
|---|---|
| Idle, Shift held | Insert literal newline at cursor |
| Idle, no Shift | Submit message to agent |
| Running | Queue message (delivered when agent goes idle) |
| Auto-submit countdown active | Cancels countdown, submits immediately |

---

## 2. Pickers (modal overlays)

Each picker **blocks all other input** while open. Keys that don't match are ignored.

### Model picker (`/model`, click model chip)

Two-step: Step 1 = select provider, Step 2 = select model.

| Key | Step 1 (provider) | Step 2 (model) |
|---|---|---|
| ↑ | Move selection up | Move selection up |
| ↓ | Move selection down | Move selection down |
| Mouse wheel | Move selection | Move selection |
| Enter | Pick provider → show models | Switch to model, close picker |
| Esc | Close picker | Back to provider list |
| Backspace | — | Delete last filter char; if filter empty → back to providers |
| Any printable char | — | Append to search filter |

### Autonomy picker (click autonomy chip)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Apply selected autonomy mode, close picker |
| Esc | Close picker (no change) |

### Resume picker (`/resume`)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Resume selected session, close picker |
| Esc | Close picker |

### Settings picker (Ctrl+S, `/settings`)

| Key | Effect |
|---|---|
| ↑ | Move field selection up |
| ↓ | Move field selection down |
| ← | Cycle field value backward / toggle boolean off |
| → | Cycle field value forward / toggle boolean on |
| Mouse wheel | Move field selection |
| Enter | Close settings (changes auto-saved) |
| Esc, Ctrl+S | Close settings |

### Statusline picker (`/statusline`, `/sl`, click chip)

| Key | Effect |
|---|---|
| ↑ | Move focus to previous chip |
| ↓ | Move focus to next chip |
| ← | Toggle focused chip on/off |
| → | Toggle focused chip on/off |
| Mouse wheel | Move focus |
| Esc | Close picker |

### Project picker (F1, `/project`)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Select project → exit with code 42 (host re-launches in new project); select "new session" → same exit-42; select "prev sessions" → opens `/resume` |
| Esc | If filter is non-empty → clear filter; if filter is empty → close picker |
| Printable char | Append to search filter |
| Backspace | Remove last filter char |

### Sessions panel (F10)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter (first press) | Select session: if same project → show confirmation; if different project → exit with code 42 |
| Enter (second press) | Confirm and resume selected session |
| Esc | If resume confirmation shown → clear confirmation; otherwise → close panel |

### Slash picker (type `/` in input)

Opens automatically when `/` is typed at the beginning of the input buffer.

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Run selected command (with arguments if any) |
| Tab | Autocomplete: fill input with selected command name, close picker |
| Esc | Close picker (return to editing) |

### File/attachment picker (type `@` or `#` in input)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Accept selected match |
| Esc | Close picker (return to editing) |

### Checkpoint timeline (`/rewind`)

Owns its own `useInput`. Rendered as a full-screen overlay.

| Key | Effect |
|---|---|
| ↑ | Select previous checkpoint |
| ↓ | Select next checkpoint |
| Enter | Rewind to selected checkpoint |
| Esc | Cancel, close timeline |

### F-key panel picker (`/f`)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Enter | Execute selected action (toggle monitor), close picker |
| Esc | Close picker |

---

## 3. Monitor overlays

Each overlay can be open simultaneously with the chat input. The Input stays mounted alongside them, so they don't own the keyboard — the central `handleKey` routes keys first.

### Overlay toggle keys

All toggles close any other overlay before opening. Key sequence: function keys preferred; Ctrl+chord as secondary when the terminal doesn't intercept it.

| Key | Overlay | Notes |
|---|---|---|
| F1 | Project switcher | Opens project picker |
| Ctrl+F, F2 | Fleet orchestration monitor | Live subagent orchestration view |
| Ctrl+G, F3 | Agents live monitor | Per-agent tool/stream status |
| Ctrl+T, F4 | Worktree monitor | Git worktree lifecycle |
| F5 | Plan panel | Session/project-scoped plan items |
| F6 | Todos monitor | Full-screen todos from /todos |
| F7 | Queue panel | Pending queue items |
| F8 | Process list | Background tool processes |
| F9 | Goal panel | Autonomous goal & coordinator controls |
| F10 | Sessions panel | Live session list (F10 toggles open/close; Enter selects) |
| F11 | Coordinator monitor | AutonomousCoordinator goals, tasks, knowledge |
| Ctrl+S | Settings picker | (also closed by Enter or Esc) |
| Ctrl+P | PhaseMonitor | AutoPhase progress (only when AutoPhase active) |

### Esc close fallback

At the bottom of the key handler, a catch-all Esc block closes whichever overlay is open, in priority order: AgentsMonitor → FleetMonitor → TodosMonitor → SettingsPicker → ProjectPicker → QueuePanel → ProcessList → GoalPanel → Help → SessionsPanel → CoordinatorMonitor. Some panels (WorktreeMonitor, PhaseMonitor) are intentionally excluded — they own their own Esc handler via `useInput` and would double-fire.

### Agents monitor (F3) internal keys

| Key | Effect |
|---|---|
| ↑ | Select previous agent in list |
| ↓ | Select next agent in list |

### Process list (F8) internal keys

| Key | Effect |
|---|---|
| ↑ | Select previous process |
| ↓ | Select next process |
| Enter (return) | Send SIGTERM to selected process |
| Delete | Send SIGKILL to selected process |
| **a** | Kill all processes (SIGTERM) |
| **A** | Kill all processes (SIGKILL) |
| **r** | Force-reset circuit breaker |

### Coordinator panel (F11) internal keys

| Key | Effect |
|---|---|
| **q**, **Q**, Esc | Close panel |

### Goal panel (F9) internal keys

| Key | Effect |
|---|---|
| **c**, **C** | Start coordinator with current goal |
| **S** | Stop coordinator |

### Plan panel (F5) internal keys

| Key | Effect |
|---|---|
| **s**, **S** | Toggle plan scope (session ↔ project) |

### Worktree monitor (F4) internal keys

| Key | Effect |
|---|---|
| Ctrl+W | Close monitor |

---

## 4. Inline input editing

These keys are active only when the input buffer is focused (no picker or overlay is open).

### Cursor movement

| Key | Effect |
|---|---|
| ← | Move cursor left by one character |
| → | Move cursor right by one character |
| Ctrl+← | Move cursor to previous word start |
| Ctrl+→ | Move cursor to next word end |
| Home | Move cursor to start of line |
| End | Move cursor to end of line |
| Ctrl+A | Move cursor to start of line |
| Ctrl+E | Move cursor to end of line |

### Multi-line navigation (when buffer contains newlines)

| Key | Effect |
|---|---|
| ↑ | Move cursor up one visual row |
| ↓ | Move cursor down one visual row |
| PageUp | Move cursor up half a screenful |
| PageDown | Move cursor down half a screenful |

On single-line buffers, ↑/↓ fall through to history navigation (see below).

### Text editing

| Key | Effect |
|---|---|
| Backspace | Delete character before cursor (token-aware: deletes whole chips like `[pasted ...]`) |
| Ctrl+Backspace, Alt+Backspace | Delete previous word (space-delimited) |
| Delete | Delete character at cursor (token-aware) |
| Ctrl+Delete | Delete next word |
| Ctrl+U | Delete entire line (clear buffer) |
| Ctrl+K | Delete from cursor to end of line |
| Ctrl+D | Delete character at cursor (forward delete) |
| Ctrl+V | Paste text from system clipboard |
| Alt+V | Paste image from clipboard → inserts `[image #N]` chip |
| Any printable char | Insert at cursor position |

### History navigation

Single-line buffers only (multi-line uses ↑/↓ for row movement).

| Key | Effect |
|---|---|
| ↑ (single line) | Scroll input history back (older submission) |
| ↓ (single line) | Scroll input history forward (newer submission) |

History navigation is skipped when any overlay is open.

### Clipboard

| Key | Effect |
|---|---|
| Ctrl+V | Paste text from system clipboard (reads clipboard via `clipboardy` or fallback) |
| Alt+V | Read image from clipboard, save to sessions dir, insert `[image #N]` chip |

### Large paste handling

Any input chunk >200 characters (or containing newlines) is collapsed to an inline `[pasted #N, L lines]` chip instead of leaking into the row.

---

## 5. Mouse interactions

Mouse tracking must be enabled (mouse mode). See `mouse.ts` for protocol details.

### scrollbar

| Action | Effect |
|---|---|
| Click/drag on right-edge scrollbar track | Jump chat viewport to that scroll position |

### Status bar chips

All clicks require `press` (not release/drag) with the left button.

| Region | Click effect |
|---|---|
| Line 1 — model chip | Open model picker (provider → model two-step) |
| Line 2 — autonomy chip | Open autonomy picker |
| Line 3 — todos chip | Toggle todos monitor overlay |
| Line 3 — todos chip area | Open statusline picker, focus [todos] |
| Line 3 — plan chip area | Open statusline picker, focus [plan] |
| Line 3 — tasks chip area | Open statusline picker, focus [tasks] |
| Line 4 — fleet chip area | Open statusline picker, focus [fleet] |
| Hidden chips are not clickable | — |

### Wheel / page scroll

| Action | Effect |
|---|---|
| Mouse wheel (no overlay) | Scroll chat by 3 rows |
| Shift+wheel (no overlay) | Scroll chat by one page |
| PageUp (no overlay) | Scroll chat up one page |
| PageDown (no overlay) | Scroll chat down one page |

All wheel/page scroll is skipped when any overlay is open (overlays own their scroll).

### Mouse modes

| Mode | Sequence | Events captured |
|---|---|---|
| Click-only | `?1000h` + `?1006h` | Press, release, wheel |
| Drag | `?1002h` + `?1006h` | Adds motion-while-button-held |
| Hover | `?1003h` + `?1006h` | Adds free motion (expensive) |

Mouse tracking is enabled per-overlay or globally. Disabled on cleanup via `?1003l ?1002l ?1000l ?1006l`.

---

## 6. Enter/Tab special behavior

### Enter on non-idle agent

If the agent is running when Enter is pressed, the message is **queued** — it is delivered when the agent returns to idle. The queue is flushed on every idle transition.

### Tab with next-steps auto-submit

When the auto-submit countdown is visible (suggested `/next` step counting down):
- **Tab** — grab the suggestion into the input buffer for editing, cancel the countdown
- **Any other key** — cancel countdown (does NOT pre-fill input)

### Enter debounce

Terminals often emit `\r\n` as two separate stdin events. All Enter handlers debounce with a 50ms window: the second event is silently dropped.

---

## 7. Component-internal keys

These components register their own `useInput` hooks in addition to the central router.

### Brain decision prompt

Shown when the Brain arbiter requires a human decision (risky operation).

| Key | Effect |
|---|---|
| **a**–**z**, **0**–**9** | Select option by letter/number |
| **d**, Esc | Deny the operation |
| Enter, **y** (in EscConfirm) | Confirm interrupt |

### Enhance panel (refine/edit)

| Key | Effect |
|---|---|
| Enter | Accept refined version |
| Esc | Reject, keep original |
| **e** | Accept English translation |
| **t** | Open for manual editing |

### ConfirmPrompt (permission dialog)

Shown when an external tool action requires human approval.

| Key | Effect |
|---|---|
| **y** | Yes — allow the action |
| **n** | No — deny the action |
| **a** | Always allow (never ask again for this tool) |
| **d** | Deny (same as n — explicit deny) |

### EscConfirmPrompt (interrupt confirmation)

Shown when Esc is pressed while agent is running AND `confirmExit` is enabled.

| Key | Effect |
|---|---|
| **y**, Enter | Confirm interrupt |
| **n**, Esc | Cancel, let agent keep running |

### Worktree monitor close

| Key | Effect |
|---|---|
| Ctrl+W | Close worktree monitor panel |

---

## Key dispatch order

The central `handleKey` function in `app.tsx` checks keys in this **strict priority order**. The first matching condition wins; all others are skipped.

1. Model picker (via `usePickerKeys`)
2. Autonomy picker
3. Resume picker
4. Settings picker
5. Statusline picker
6. Project picker
7. Sessions panel
8. Slash picker (if `/` in buffer)
9. F-key panel picker
10. File/attachment picker
11. **Esc while agent is busy** → interrupt (with optional confirm dialog)
12. F-key overlay toggles (F1–F11, Ctrl+chords)
13. Catch-all **Esc** → close whichever overlay is open
14. **`?` on empty prompt** → help overlay
15. **Enter** → submit / queue message
16. **Tab** with auto-submit countdown → grab suggestion
17. **Backspace/Ctrl+Backspace** → delete
18. **Delete/Ctrl+Delete** → forward delete
19. **←/→ (plain/Ctrl)** → cursor movement
20. **Home/End** → cursor to start/end
21. **↑/↓** on multi-line buffer → row navigation
22. **↑/↓** on single-line, no overlay → history scroll
23. **Ctrl+P** → PhaseMonitor toggle
24. **Ctrl+A/E/U/K/D** → editing shortcuts
25. **Ctrl+V** → paste text
26. **Alt+V** → paste image
27. Any printable char → insert at cursor

Steps 14–27 are blocked when any overlay is open (checked via `overlayOpen` flag).

## Key event model

Keys are decoded by two parallel mechanisms:

- **Ink's `useInput`** — handles all standard keys (arrows, letters, Ctrl, Esc, Tab, Backspace, Return, Shift). Provides `KeyEvent` booleans.
- **Raw stdin** — catches Home/End (CSI sequences not decoded by Ink 5.x), Backspace as `\x08` (Windows Terminal sends BS, not DEL), Delete, F1–F12 (CSI `~` sequences), mouse SGR reports, and ESC+buffering for Alt+Backspace detection.

The raw handler uses a 10ms ESC buffer: when Esc is received, it waits 10ms for a follow-up byte. If Backspace (`\x7f`/`\x08`) arrives within 10ms, it's emitted as Ctrl+Backspace (delete word). After 10ms with no follow-up, a real Esc press is emitted to Ink.

Both paths converge on `onKey(input, key)` → `handleKey()` in App.
