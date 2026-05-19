<!-- dfmt:v1 begin -->
# Context Discipline — REQUIRED

Read this section at the start of every conversation in this project.

## Rule 1 — Prefer targeted reads over raw dumps

Use `grep` with `context_lines` / `output_mode`, `glob` with patterns,
and `read` with `offset`/`limit` instead of dumping entire files.
When a tool output exceeds ~50 lines, prefer to specify exactly what
you need rather than loading the whole result into context.

## Rule 2 — On tool failure, report and fall back

If a tool errors or is unavailable, report the failure (one short line)
and continue with the best available alternative. Do not silently
retry with the same inputs.

## Rule 3 — Record user decisions

When the user states a preference or correction ("use X instead of Y",
"do not modify Z"), call `remember` with a note tagged `decision` so
the choice survives context compaction. Example:
`remember` tool with text like `[decision] use pnpm instead of npm`.

## Why these rules matter

A single raw shell output above 8 KB can push earlier context out of the
window, erasing the conversation's history. Following the rules above
preserves it.
<!-- dfmt:v1 end -->
