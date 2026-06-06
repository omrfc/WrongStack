# /skill-gen - LLM-Guided Skill Authoring

## What it does

Launches an interactive skill creation session. The command returns `runText` that asks the AI to read the `skill-creator` skill and guide the user through defining the skill name, trigger description, and instruction body.

No separate wizard owns the full flow; the LLM handles the conversation and file writing.

## Usage

| Usage | Effect |
|---|---|
| `/skill-gen` | Start skill creation |
| `/skill-gen list` | List existing skills |
| `/skill-gen edit <name>` | View an existing skill's full body and path |

## How it works

1. The command asks the AI to read `packages/core/skills/skill-creator/SKILL.md`.
2. The AI asks clarifying questions about the skill's purpose and scope.
3. The AI generates `SKILL.md` content with frontmatter (`name`, `description`, `version`) and body.
4. The AI writes to the appropriate scope, usually `<projectRoot>/.wrongstack/skills/<name>/SKILL.md` for project skills.

## Skill output format

```markdown
---
name: my-skill
description: |
  Use this skill when <trigger condition>.
  Triggers: user says "X", "Y".
version: 1.0.0
---

# My Skill

## Overview
One-line description of what this skill does.

## Rules
1. Rule one
2. Rule two
```

## Code reference

- `packages/core/src/plugins/skills-plugin.ts`
- `packages/core/skills/skill-creator/SKILL.md`
- `packages/core/src/execution/skill-loader.ts`
- `packages/core/tests/plugins/skills-plugin.test.ts`
- `docs/skills.md`
