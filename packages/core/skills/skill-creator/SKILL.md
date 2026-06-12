---
name: skill-creator
description: |
  Use this skill when the user wants to create a new AI skill in WrongStack.
  Triggers: user says "create a skill", "new skill", "add a skill", "skill definition".
version: 1.1.0
---

# Skill Creator — WrongStack

## Overview

Guides the creation of new WrongStack skills. A skill is a Markdown file with YAML frontmatter — the first sentence of the description is the trigger. You are the wizard: ask questions, validate answers, write the file.

## Rules

1. First sentence of `description` = trigger — this is the only thing the skill loader matches on.
2. Name must be kebab-case: `my-skill`, `docker-deploy` — lowercase, hyphens only.
3. Skills live in `.wrongstack/skills/<name>/SKILL.md` (project level).
4. After the trigger sentence, add `Triggers: user says "X", "Y", "Z".`.
5. Content must be actionable — rules, patterns, anti-patterns, not just prose.
6. End with "Skills in scope" listing related skills for delegation.
7. Don't let skill names collide with existing skills.

## Patterns

### Do

```markdown
---
name: docker-deploy
description: |
  Use this skill when deploying Docker containers to a production cluster.
  Triggers: user says "docker", "container", "deploy", "dockerfile", "image".
version: 1.0.0
---

# Docker Deploy — WrongStack

## Overview
...
## Rules
...
## Patterns
...
## Skills in scope
```

### Don't

```markdown
---
name: MySkill # ❌ PascalCase
name: my_skill      # ❌ underscore
description: |
  This skill is about Docker.  # ❌ no trigger sentence
---
```

## Skill format

Every skill is a Markdown file with YAML frontmatter:

```markdown
---
name: my-skill-name
description: |
  Use this skill when <trigger situation>.
  Triggers: user says "keyword", "another keyword".
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
\`\`\`ts
// good example
\`\`\`

### Don't
\`\`\`ts
// bad example
\`\`\`

## Workflow
1. Step one
2. Step two
```

## File Location

Skills live in directories under these paths (priority order):

1. **Project**: `<project>/.wrongstack/skills/<name>/SKILL.md`
2. **User global**: `~/.wrongstack/skills/<name>/SKILL.md`
3. **Bundled**: `packages/core/skills/<name>/SKILL.md` (read-only, for core team)

For user-created skills: always use path 1 (project level).

## Workflow

1. **Ask the name** — suggest kebab-case, validate format
2. **Ask the trigger** — "What situation should activate this skill?"
3. **Ask the coverage** — what rules, patterns, workflows?
4. **Generate the SKILL.md** — write to `.wrongstack/skills/<name>/SKILL.md`
5. **Confirm** — show the path, remind them to use `/skill` to list skills

## Validation Checklist

Before writing the file, verify:
- [ ] Name is valid kebab-case
- [ ] Name doesn't collide with existing skills
- [ ] Description has a clear trigger sentence
- [ ] Content is actionable (rules, patterns, not just prose)
- [ ] File will be placed in `.wrongstack/skills/`

## Skills in scope

- `prompt-engineering` — for crafting the skill description and prompt text
- `git-flow` — for committing the new skill file
- `output-standards` — for standardized `<next_steps>` formatting