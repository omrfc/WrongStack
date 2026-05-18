---
name: skill-creator
description: |
  Use this skill when the user wants to create a new AI skill.
  Covers skill format, file structure, naming conventions,
  and the interactive creation workflow.
version: 1.0.0
---

# Skill Creator

Guide the user through creating a new AI skill. You are the wizard — ask questions, validate answers, write the file.

## Skill Format

Every skill is a Markdown file with YAML frontmatter:

```markdown
---
name: my-skill-name
description: |
  First sentence is the trigger — when should this skill activate?
  Rest describes what the skill covers.
version: 1.0.0
---

# Skill Title

## Overview
What this skill does.

## Rules
- Rule 1
- Rule 2

## Patterns
### Do
```code example```

### Don't
```anti-pattern example```

## Workflow
1. Step one
2. Step two
```

## File Location

Skills live in directories under these paths (priority order):

1. **Project**: `<project>/.wrongstack/skills/<name>/SKILL.md`
2. **User global**: `~/.wrongstack/skills/<name>/SKILL.md`
3. **Bundled**: `packages/core/skills/<name>/SKILL.md` (read-only)

For user-created skills, always use path 1 (project level).

## Naming Rules

- kebab-case: `my-skill`, `docker-deploy`, `api-testing`
- Lowercase letters, numbers, hyphens only
- No spaces, no underscores, no uppercase
- Directory name = skill name

## Description Rules

- First sentence = trigger condition. This is when the skill activates.
  - Good: "Use this skill when deploying Docker containers."
  - Bad: "This skill is about Docker."
- Be specific about scope — what technologies, what situations
- Multi-line descriptions use YAML block scalar (`|`)

## Content Guidelines

- **Rules**: concrete do/don't rules, not vague advice
- **Patterns**: actual code examples, not pseudocode
- **Anti-patterns**: show what NOT to do with real code
- **Workflows**: step-by-step, actionable, not theoretical
- Keep it focused — one skill = one concern

## Creation Workflow

When the user wants to create a skill:

1. **Ask the name** — suggest kebab-case, validate format
2. **Ask the description** — guide them to write a good trigger sentence
3. **Ask what to cover** — rules, patterns, workflows they want in the body
4. **Generate the SKILL.md** — write the file to `.wrongstack/skills/<name>/SKILL.md`
5. **Confirm** — show the path, remind them to use `/skill` to list skills

## Validation Checklist

Before writing the file, verify:
- [ ] Name is valid kebab-case
- [ ] Name doesn't collide with existing skills
- [ ] Description has a clear trigger sentence
- [ ] Content is actionable (rules, patterns, not just prose)
- [ ] File will be placed in `.wrongstack/skills/`
