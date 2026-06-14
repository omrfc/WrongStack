# Output Standards — WrongStack (Compact)

Standardizes the format of agent output, particularly the `<next_steps>` section in final messages.

## Rules

1. Only the leader agent includes `<next_steps>` — subagents report findings only.
2. Tags must be properly closed — `<next_steps>...</next_steps>`.
3. No markdown inside tags — plain text only, one action per line.
4. Use imperative mood — "Fix X", not "Fixed X".
5. Be specific — mention file paths, tool names, or exact commands.
6. Items must be concrete actionable commands — no declarations of intent.
7. Keep concise — max 5 items unless the task genuinely requires more.

## Format

```
<next_steps>
1. [Priority] Action item with file:line reference
2. [Priority] Second action item
</next_steps>
```