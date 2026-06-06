# Collab Debug - Multi-Agent Code Review

`collab_debug` runs **BugHunter + RefactorPlanner + Critic** in parallel against the same codebase. Each agent scans independently, shares findings through FleetBus, and Critic produces an integrated final verdict.

---

## How It Works

```
BugHunter ----.
              +--> FleetBus --> Critic --> final report
Refactor -----'   (events)     (listens + judges)
```

- **BugHunter** - Detects bugs, anti-patterns, and code smells -> emits `bug.found` events
- **RefactorPlanner** - Listens to BugHunter events -> creates refactor plans -> emits `refactor.plan` events
- **Critic** - Listens to both BugHunter and RefactorPlanner outputs -> emits `critic.evaluation` events -> produces the final verdict

---

## Usage Limits

> **Rule:** the number of files selected by `targetPaths` should be **20-30 at most**.

**Why?** Each agent scans all target files. 3 agents x N files means multiple-iteration cost. Large targets cause timeouts and excessive token usage.

| Target | File Count | Example |
|---|---|---|
| Good | 10-20 | `packages/core/src/agents/**/*.ts` |
| Limit | 20-30 | `packages/core/src/director/**/*.ts` |
| Avoid | 50+ | `packages/**/src/**/*.ts` (entire monorepo) |

---

## Recommended Usage Pattern

### Package-by-package approach

For a monorepo, target **one module/package** instead of the whole package set:

```js
// Good - single package, limited files
collab_debug(["packages/core/src/agents/**/*.ts"])

// Good - a subdirectory is even better
collab_debug(["packages/runtime/src/sessions/**/*.ts"])

// Bad - entire monorepo
collab_debug(["packages/**/src/**/*.ts"])
```

### Glob Patterns

```js
// Target with a glob inside one package
collab_debug(["packages/core/src/**/*.ts"])           // under core/src (too broad)
collab_debug(["packages/core/src/agents/**/*.ts"])   // only under agents

// Multiple small targets are okay
collab_debug([
  "packages/core/src/agents/**/*.ts",
  "packages/core/src/director/**/*.ts"
])
```

---

## When To Use It

| Scenario | Is `collab_debug` appropriate? |
|---|---|
| Code was written for a new feature and needs a final review | Yes |
| A refactor is planned in an existing module | Yes |
| A file may contain a security vulnerability | Yes |
| Scanning the entire repository | No - do it package by package |
| Continuous CI/CD integration | No - a single-agent scan is enough |
| Very large file (1000+ lines) | Caution - review it on its own |

---

## Alternatives

- **Need a broad scan** -> run a standalone `bug-hunter` subagent (no parallel pipeline, faster)
- **Only need type checking** -> use the `typecheck` tool
- **Only need linting** -> use the `lint` tool
- **Manual review** -> use targeted grep/read from the director

---

## Timeout and Budget

The default timeout is **10 minutes (600000 ms)**. It can be increased for large targets, but that should be avoided; shrinking the target is almost always preferable.

---

## Output Report Structure

The final report produced by Critic contains:

```
overall_verdict: "approve" | "needs_revision" | "reject"

BugHunter findings:
- [file:line] bug_type: description

RefactorPlanner plans:
- [file] refactor_type: description

Critic evaluation:
- strengths: [...]
- weaknesses: [...]
- recommendation: [...]
```
