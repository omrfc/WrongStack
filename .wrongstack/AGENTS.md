# AGENTS.md

> **DO NOT DELETE THIS FILE.** It is loaded into WrongStack's system prompt as
> persistent project context. Previous content here may contain decisions,
> architecture notes, domain knowledge, or verification history that should be
> preserved. Merge additions rather than replacing.

## Project brief

- **Purpose:** _What does this project do and why does it exist?_
- **Primary users:** _Who uses it: developers, operators, customers, internal systems?_
- **Runtime / deployment:** _CLI, server, browser, worker, library, package?_

> Auto-detected: package.json scripts

## How to work safely

- _Project-specific rules the agent should always follow._
- _Files, generated artifacts, migrations, or config the agent should not edit without asking._
- _Preferred style or architecture choices not obvious from the code._
- _Known fragile areas or historical bugs that deserve extra caution._

## Commands

| Command | Script |
|---------|--------|
| Build | `pnpm run build` |
| Test | `pnpm test` |
| Lint | `pnpm run lint` |
| Run locally | _TODO_ |

## Key files and entry points

| File / directory | Role |
|---|---|
| _src/_ | _Main source entry point(s)_ |
| _tests/_ | _Test root or convention_ |
| _docs/_ | _Architecture, runbooks, design notes_ |
| _scripts/_ | _Automation scripts (CI, release, install, etc.)_ |

## Architecture notes

_Summarize the important modules, data flow, boundaries, and ownership rules.
Mention anything a newcomer might misread or that looks unusual but is intentional._

### Dependency layers

_Describe the key dependency direction or layered structure, e.g.: "core has no
runtime deps; cli assembles everything above it."_

### Extension points

_Plugin, MCP, extension hooks, custom tools — what's wired up and how._

## Domain knowledge

_Business rules, acronyms, invariants, external services, and notes where the
code looks unusual but is intentional. E.g.: "IDs are ULIDs, not UUIDs", "the
`draft` flag means uncommitted billing metadata", "MCP servers are restarted
on disconnect with exponential backoff, up to 3 attempts"._

## Verification checklist

- _What should be run after code changes?_
- _What manual smoke test proves the common path still works?_
- _What failure modes deserve extra attention?_
- _Any known flaky tests or environment-dependent behavior?_

## Useful pointers

- _Docs, dashboards, runbooks, issue trackers, design notes, owner contacts._
- _Related projects or repositories._