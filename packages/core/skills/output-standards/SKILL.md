---
name: output-standards
description: |
  Use this skill when defining or enforcing output formatting standards for agent
  responses in WrongStack. Triggers: user says "next steps format", "output standard",
  "response format", "final message format", "standardize next steps".
version: 1.0.0
---

# Output Standards — WrongStack

Standardizes the format of agent output, particularly the `next_steps` section
in final messages. This ensures system-level parsing and automation can reliably
extract structured data from agent responses.

## Rules

1. **Every final message MUST include `<next_steps>` tag** — no exceptions for completed tasks.
2. **Tags must be properly closed** — `<next_steps>...</next_steps>` with exact tag names.
3. **No markdown inside tags** — plain text only, one action per line.
4. **Use imperative mood** — "Fix X", "Run Y", not "Fixed X" or "Running Y".
5. **Be specific** — mention file paths, tool names, or exact commands.
6. **Keep concise** — max 5 items unless the task genuinely requires more.

## Output Format

Every agent's final message MUST end with this structure:

```
[... task results ...]

<next_steps>
1. First actionable next step — imperative, specific
2. Second actionable next step
3. Third actionable next step (if needed)
</next_steps>
```

### Format Requirements

| Element | Rule | Example |
|---------|------|---------|
| Opening tag | `<next_steps>` on its own line | `<next_steps>` |
| Numbered items | `1. ` prefix, one per line | `1. Fix auth bug in core/session.ts` |
| Closing tag | `</next_steps>` on its own line | `</next_steps>` |
| Blank line before | Optional but recommended | Improves readability |
| Blank line after | Not required | — |

### ✅ Correct Examples

```
Task completed successfully.

<next_steps>
1. Fix shell injection in packages/cli/src/slash-commands/dev.ts:15
2. Replace Math.random() with randomUUID() in 4 files
3. Run pnpm run typecheck to verify fixes
</next_steps>
```

```
Analysis finished. Found 3 critical issues.

<next_steps>
1. [CRITICAL] packages/cli/src/slash-commands/dev.ts:15 — exec() → execFile()
2. [HIGH] packages/core/src/session-registry.ts:145 — remove ! assertion
3. [HIGH] packages/core/src/session-registry.ts:169 — remove ! assertion
</next_steps>
```

### ❌ Incorrect Examples

```
Task done. Next steps: 1) fix bug 2) run tests

# ❌ No tags — not parseable
```

```
<next_steps>
- Fix the bug in auth.ts  # ❌ Dash, not number
- Run tests
</next_steps>

# ❌ Wrong bullet character
```

```
<next_steps>
1. **Fix the bug** — use execFile instead  # ❌ Markdown inside tags
2. Run `pnpm test`
</next_steps>

# ❌ Markdown formatting not allowed inside tags
```

```
Next steps:
1. Fix auth.ts

# ❌ Missing opening/closing tags
```

## Subagent Requirements

When a **leader agent** synthesizes output from **subagents**, the leader MUST:

1. Aggregate all subagent `next_steps` into a unified `<next_steps>` section
2. Remove duplicates (dedupe by file path + action)
3. Re-prioritize if needed (critical > high > medium > low)
4. Keep the unified list within the 5-item guideline, but no hard cap

When a **subagent** completes its task, it MUST:

1. Include its own `<next_steps>` section in the final message
2. Report what it found/achieved, not what the leader should do
3. Leader will aggregate and decide on overall next steps

## Anti-patterns

- **Don't use markdown inside `<next_steps>`** — plain text only
- **Don't skip the tag** — even if next steps are obvious, include them
- **Don't use dashes or asterisks** — use `1.`, `2.`, `3.` numbering
- **Don't be vague** — "fix bugs" is useless, "fix auth/session.ts:42" is actionable
- **Don't exceed 5 items without reason** — if >5, it's probably not a single task

## Skills in scope

- `bug-hunter` — inherits output-standards for bug reports
- `security-scanner` — inherits output-standards for security findings
- `refactor-planner` — inherits output-standards for refactoring plans
- `architect` — inherits output-standards for architecture analysis
- `tech-stack` — inherits output-standards for dependency reports
