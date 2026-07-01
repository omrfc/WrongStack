# /f — F-key panel launcher

Opens the TUI's F-key panels by number, for terminals or keyboards where the
physical F-keys are captured (tmux, some terminal emulators, laptops with an
Fn layer). `/f 3` does exactly what pressing F3 does.

## Usage

| Command | Effect |
|---|---|
| `/f` | List all twelve panels with their numbers. |
| `/f <1-12>` | Open the corresponding panel. |
| `/f1` … `/f12` | Same, as single commands (hidden from the slash picker). |

## Panel map

| Key | Panel |
|---|---|
| F1 | project switcher |
| F2 | fleet orchestration monitor |
| F3 | agents live monitor |
| F4 | worktree monitor |
| F5 | autonomy settings |
| F6 | todos monitor overlay |
| F7 | queue panel |
| F8 | process list overlay |
| F9 | goal panel |
| F10 | live sessions panel |
| F11 | coordinator monitor |
| F12 | status line picker |

## Notes

- Panels are a TUI feature. In the plain REPL (or headless mode) the command
  prints a note instead of opening an overlay.
- The `/f1`–`/f12` aliases exist so typing `/f1` without a space also works;
  they are hidden from the command picker to avoid clutter.

See also: `/mouse` (mouse mode for clicking panels), `/statusline`.
