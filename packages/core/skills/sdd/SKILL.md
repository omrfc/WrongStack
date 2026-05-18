---
name: sdd
description: |
  Specification-driven development workflow. Covers spec parsing,
  task graph generation from requirements, dependency tracking,
  interactive spec building, persistence, visualization, critical
  path analysis, spec versioning, and auto-execution.
version: 2.0.0
---

# Spec-Driven Development

Guide the agent through specification-first development workflow.

## Core Principle

Every non-trivial change starts with a spec. The spec is the source of truth. Tasks are derived from specs, not the other way around.

## Workflow

```
Spec → Analysis → Task Graph → Visualization → Execution → Done
  ↑                    ↓
  └── Versioning ──────┘ (incremental updates)
```

### When to use

- New feature implementation
- Bug fix with complexity
- Refactoring with scope
- Any task requiring more than 1 hour

## Slash Command: /sdd

The `/sdd` command provides the full SDD workflow through the REPL/TUI:

```
/sdd new [title]         — Interactive spec builder (question-driven)
/sdd from <template>     — Create from template (feature|bugfix|refactor|infra|integration|cli-command)
/sdd list                — List saved specs
/sdd show <id>           — Show spec details + completeness analysis
/sdd analyze <id>        — Deep spec analysis (gaps, risks, suggestions)
/sdd tasks <id>          — Generate task graph from spec
/sdd graph <id>          — ASCII visualization of task graph
/sdd status <id>         — Compact task list grouped by status
/sdd critical <id>       — Critical path analysis with bottlenecks
/sdd execute <id>        — Auto-execute tasks (dependency-aware)
/sdd templates           — List available spec templates
/sdd version <id>        — Show spec version history
```

### Full workflow example

```
1. /sdd new Auth System
2. Answer questions (title, overview, requirements, acceptance criteria)
3. /sdd tasks <id>           → generates task graph
4. /sdd graph <id>           → visualize dependencies
5. /sdd critical <id>        → find bottlenecks
6. /sdd execute <id>         → run tasks autonomously
```

## Spec Templates

Built-in templates for common scenarios:

| Template | Best for |
|---|---|
| `feature` | New feature development |
| `bugfix` | Bug fix with root cause analysis |
| `refactor` | Code refactoring with goals |
| `infra` | Infrastructure/tooling changes |
| `integration` | External service integration |
| `cli-command` | New CLI commands/slash commands |

## Spec sections

A good spec includes:

1. **Overview** — What problem does this solve?
2. **Requirements** — Functional and non-functional requirements with priorities
3. **Architecture** — High-level design if needed
4. **API Design** — If applicable
5. **Data Model** — If applicable
6. **Security** — Auth, permissions, data handling
7. **Acceptance Criteria** — How do we know it's done?

### Requirement format

```
[functional] User can authenticate with OAuth2
[security] Rate limiting: 100 req/min per user
[performance] Response time < 200ms p95
```

Priority markers: `[critical]`, `[high]`, `[medium]`, `[low]`

## Persistence

Specs and task graphs are persisted under `.wrongstack/`:

```
.wrongstack/
  specs/
    _index.json           — Spec index for fast listing
    <uuid>.json           — Individual spec files
  task-graphs/
    _index.json           — Task graph index
    <uuid>.json           — Individual graph files (Map-aware JSON)
```

## Task generation

Tasks are derived from requirements:

- Each requirement → one or more tasks
- Requirements with acceptance criteria → separate test tasks
- Critical requirements → tasks marked critical
- Blocked requirements → blocked tasks

## Task states

```
pending → in_progress → review → completed
              ↓
           blocked (waiting on dependencies)
              ↓
           failed
```

## Critical Path Analysis

The critical path identifies:

- **Bottleneck tasks** that block the most downstream work
- **Parallel groups** of tasks that can execute concurrently
- **Ready tasks** that can start immediately
- **Execution order** respecting all dependencies

## Spec Versioning

When requirements change:

- Added requirements → new tasks generated
- Removed requirements → tasks removed
- Modified requirements → tasks updated (description, priority, dependencies)
- Version history tracked for audit trail

## Auto-Execution

The auto-executor runs tasks with:

- Dependency-aware ordering (blocked tasks wait)
- Automatic retry on transient failures (configurable max retries)
- Deadlock detection (all remaining blocked by failed tasks)
- Progress tracking and event emission

## Done conditions

A feature is done when:
1. All critical and high priority tasks completed
2. Tests written and passing
3. Documentation updated
4. No blocked tasks remaining
