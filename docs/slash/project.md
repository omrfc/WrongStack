# /project — Project picker & registry

Switch between known projects or manage the project registry. Projects are
registered in `~/.wrongstack/projects.json`; each entry has a user-friendly
name, a root path, and an auto-generated slug used for per-project data
storage under `~/.wrongstack/projects/<slug>/`.

Alias: `/projects`.

## Subcommands

| Command | Effect |
|---|---|
| `/project` | Open the interactive picker (arrow keys, Enter to confirm; falls back to `list` without a TTY). |
| `/project ls` / `list` | List all known projects with last-seen age. |
| `/project add <path> [name]` | Register a project. |
| `/project rename <slug> <name>` | Rename a project. |
| `/project remove <slug>` | Remove a project from the registry (files untouched). |
| `/project switch <dir> [--name <n>]` | Spawn wstack in the target directory. |
| `/project switch --interactive` / `-i` | Open the picker explicitly. |

## What "switch" does

Selecting a project stops the running agents and spawns a **fresh wstack
session** in the selected project directory (the same exit-42 respawn path
the F1 project switcher uses). The current session stays open until the
handoff completes — the spawned successor deliberately detaches so it
survives the parent exiting.

## Examples

```
/project
/project add D:\Codebox\PROJECTS\MyApp "My App"
/project rename my-app "My App v2"
/project switch ../other-repo --name other
```

## Notes

- `remove` only edits the registry — nothing is deleted on disk; per-project
  data stays under `~/.wrongstack/projects/<slug>/`.
- The picker is also on F1 in the TUI.

See also: `/working_dir` (move within the current project), F1 project
switcher panel.
