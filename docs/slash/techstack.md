# /techstack — Project Dependency Auditor

## What it does

`/techstack` spawns a subagent that scans every `package.json` in the project, looks up each dependency's latest version on the npm registry, and produces a structured report (`techstack.md` or `techstack.json`) in the project root.

The subagent uses the **tech-stack** skill for its verification rules — blocking dead packages, flagging prehistoric technology, and preferring Node.js built-ins over third-party packages.

## Usage

```
/techstack              Scan dependencies + write techstack.md
/techstack --json       Write techstack.json instead of markdown
/techstack --init       Init-mode: compare scaffolded vs latest versions
```

## Report structure

The markdown report groups packages by status:

| Status | Meaning |
|--------|---------|
| 🟢 **Up to Date** | Current version within 1 minor of latest |
| 🟡 **Outdated** | Behind latest (major gap or >1 minor gap) |
| 🔴 **Critical** | Known CVEs, deprecated, or >2 years without release |
| ☠️ **Dead / Obsolete** | Deprecated, archived, or superseded ≥5 years ago |

Each group has a table with: package name, current version, latest version, age, and notes.

The report ends with a **Recommendations** section listing the top 3-5 most urgent fixes.

## Init-mode (`--init`)

When called with `--init` (or automatically by the init hook), the subagent:
- Produces a comparison between scaffolded versions and the current stable versions
- Warns specifically about version numbers the LLM may have hallucinated
- Uses a friendlier format suitable for first-time setup context

This is also triggered automatically when `/init` runs for the first time on a new project.

## How it works

```
1. discoverPackageFiles()        → Finds package.json in root + workspace packages
2. buildTechStackTask()          → Constructs detailed subagent instructions
3. opts.onSpawn(task, { name })  → Spawns general-purpose subagent
4. Subagent executes             → Reads package.json files → fetches npm registry → writes report
5. Subagent reports              → Chat summary appears when done
```

### Package discovery

The command reads `pnpm-workspace.yaml` (if present) to find workspace packages, then scans each subdirectory for `package.json`. Single-package projects just get the root `package.json`.

### Subagent design

The subagent is a general-purpose coding agent — not a fleet role. The task description activates the `tech-stack` skill by using its trigger keywords ("install", "package", "dependency", "version", etc.). The subagent gets:

- Full access to `fetch()` for npm registry lookups
- `read` and `write` tools for the report file
- `AbortSignal.timeout(10000)` guard on every network call
- Instruction to parallel-fetch where possible and complete in 2-3 iterations

## Hook into /init

The `/init` slash command and `wstack init` subcommand both use `detectProjectFacts()` from `helpers.ts`. The techstack scan is triggered after the AGENTS.md write when:
1. A `package.json` is detected (Node.js project)
2. The AGENTS.md is being created for the first time (no existing file)

## Code reference

- `packages/cli/src/slash-commands/techstack.ts` — slash command
- `packages/core/skills/tech-stack/SKILL.md` — skill rules used by the subagent
- `packages/cli/src/slash-commands/index.ts` — registration
- `packages/cli/src/slash-commands/init.ts` — init hook integration point

## Related commands

| Command | What it does |
|---------|-------------|
| `/init` | Creates AGENTS.md + triggers techstack on first run |
| `/spawn` | Generic subagent dispatch (techstack uses this internally) |
| `/diag` | System diagnostics (complementary to tech stack health) |
