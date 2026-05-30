# Skill Writing Guide

Skills are Markdown files that inject domain-specific knowledge into the agent's system prompt. They activate automatically when the agent detects a matching context — no code required.

---

## Quick start

```
<project>/.wrongstack/skills/
  my-skill/
    SKILL.md        ← this is the only required file
```

A skill is a directory containing a `SKILL.md` file with YAML frontmatter. That's it.

```markdown
---
name: my-skill
description: |
  One-sentence summary of what this skill covers and when to activate it.
  The agent reads this description to decide whether the skill is relevant.
version: 1.0.0
---

# My Skill

Body content injected into the system prompt when the skill activates.
Keep it concise, actionable, and focused on one domain.
```

---

## File format

### Frontmatter (required)

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique identifier. First-seen wins on collisions across layers. |
| `description` | ✅ | One-sentence trigger summary. The agent uses this to decide relevance. |
| `version` | ❌ | SemVer string. Informational only — not used for comparison. |

### Body (required)

Everything after the frontmatter delimiter (`---`) is the skill content. This is injected verbatim into the system prompt when the skill is active. Keep it under 2000 tokens — the system prompt has a budget.

---

## Discovery

Skills are discovered at boot in three layers. The first layer with a given `name` wins — project skills shadow user skills, which shadow bundled skills.

| Priority | Location | Scope | Use case |
|---|---|---|---|
| 1 (highest) | `<project>/.wrongstack/skills/` | Per-project, committed to git | Repo-specific conventions, build system quirks, team standards |
| 2 | `~/.wrongstack/skills/` | Per-user, not committed | Personal preferences, cross-project habits |
| 3 (lowest) | Bundled with `@wrongstack/core` | Ships with the package | General-purpose skills (git-flow, bug-hunter, etc.) |

### Directory structure

```
skills/
  <skill-name>/
    SKILL.md          ← required
    (any other files) ← ignored by the loader, but you can reference them
```

The loader scans each directory for subdirectories containing `SKILL.md`. Files outside this structure are ignored.

---

## Bundled skills

WrongStack ships with 16 bundled skills:

| Skill | Description |
|---|---|
| `api-design` | REST API design, error codes, pagination, auth patterns |
| `audit-log` | Log parsing, anomaly detection, pattern recognition across sessions |
| `bug-hunter` | Systematic bug and code smell detection, severity ranking |
| `docker-deploy` | Docker containerization, multi-stage builds, image scanning |
| `git-flow` | Commit message style, branch hygiene, safe history operations |
| `multi-agent` | Leader/worker roles, task delegation, done conditions, result aggregation |
| `node-modern` | Node.js ≥ 22 idioms: ESM-only, native fetch, AbortSignal patterns |
| `observability` | Structured logging, traces, metrics, redaction, instrumentation |
| `prompt-engineering` | System prompt design, tool descriptions, task instructions for LLMs |
| `react-modern` | React 19+ Server Components, useTransition, Suspense, the `use` hook |
| `refactor-planner` | Dependency mapping, risk assessment, phased planning, migration strategy |
| `sdd` | Spec parsing, task graph generation, dependency tracking, done-condition execution |
| `security-scanner` | Code and configuration security vulnerability scanning |
| `skill-creator` | Guide to creating new WrongStack skills with YAML frontmatter |
| `testing` | vitest patterns, mocking, coverage, unit/integration/e2e test strategy |
| `typescript-strict` | Strict null checks, exhaustive switch, branded types, discriminated unions |

Override any bundled skill by creating a project- or user-level skill with the same `name`.

---

## Writing effective skills

### Description quality

The `description` field is the trigger. The agent reads it to decide whether the skill is relevant to the current task. Make it:

- **Specific**: "Use this skill when writing or reviewing React 19+ code" ✅
- **Not too broad**: "General programming help" ❌
- **Action-oriented**: "Use when proposing, creating, or reviewing git commits" ✅
- **Scope-limited**: Include what the skill does NOT cover if there's ambiguity

### Body structure

```markdown
---
name: example
description: |
  Use this skill when doing X. Covers Y and Z.
version: 1.0.0
---

# Title

One-line summary of the skill's purpose.

## Section 1 — Domain rules

- Rule 1
- Rule 2
- Rule 3

## Section 2 — Patterns

| Pattern | When to use | Example |
|---|---|---|
| A | When X | `code example` |
| B | When Y | `code example` |

## Anti-patterns

- Don't do X because Y.
- Avoid Z — it causes W.
```

### Token budget

The system prompt has a finite context window. Skills that are too long will be truncated or will crowd out other important context. Guidelines:

- **Target**: 200–800 tokens per skill
- **Hard limit**: ~2000 tokens (the loader doesn't enforce this, but the compactor will trim)
- **Tip**: Use tables and bullet points over prose. Code examples should be minimal — show the pattern, not the full implementation.

### Common mistakes

| Mistake | Why it's bad | Fix |
|---|---|---|
| Too broad description | Activates on irrelevant tasks, wastes context | Narrow the trigger to specific scenarios |
| No examples | Agent can't infer the pattern from rules alone | Add at least one concrete code example |
| Too long | Crowds out other skills and user messages | Split into multiple focused skills |
| Duplicate name | Shadows the other skill silently | Use unique, descriptive names |
| No anti-patterns | Agent may apply the skill incorrectly | List what NOT to do |

---

## Viewing discovered skills

```bash
# CLI subcommand
wrongstack skills

# Slash command (in REPL/TUI)
/skill
```

Both show the skill name, source layer (project / user / bundled), and description.

---

## Example: Project-specific skill

```markdown
---
name: acme-conventions
description: |
  Use this skill when writing or modifying code in the acme-web repository.
  Covers naming conventions, test patterns, and deployment rules specific to Acme.
version: 1.0.0
---

# Acme Web Conventions

## Naming

- Components: PascalCase (`UserProfile.tsx`)
- Hooks: `use` prefix (`useUserData.ts`)
- Utilities: camelCase (`formatDate.ts`)
- Constants: SCREAMING_SNAKE (`MAX_RETRIES`)

## Testing

- Unit tests co-located: `foo.ts` → `foo.test.ts`
- Integration tests in `tests/integration/`
- Use `vi.mock()` for external deps, never for internal modules
- Run `pnpm test` before every commit

## Deployment

- `main` = production, `develop` = staging
- Never push directly to `main` — use PRs
- CI runs lint + typecheck + test on every PR
```

Save as `<project>/.wrongstack/skills/acme-conventions/SKILL.md` and commit it.
