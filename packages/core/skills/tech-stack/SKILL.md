---
name: tech-stack
description: |
  Use this skill when choosing, installing, or recommending packages, libraries,
  frameworks, or tooling — any decision that involves a version number or a
  technology name. This skill enforces latest-version verification, blocks
  dead/obsolete choices, and intervenes when the LLM hallucinates version
  numbers or suggests 5+ year-old technology.
  Triggers: user says "install", "package", "dependency", "upgrade",
  "latest version", "add package", "npm install", "pnpm add", "what version",
  "which library", "tech stack", "choose framework".
version: 1.0.0
---

# Tech Stack Validator — WrongStack

## Overview

Intervening validation layer that fires before a package, library, or framework
choice is committed. Verifies that the selected technology and version are
current, exist in reality, and are not dead/abandoned. Runs as a single-shot
delegate — fast, read-only, fire-and-forget.

## Rules

1. **Verify existence.** Before accepting a package name, search the npm registry
   (`https://registry.npmjs.org/<package>/latest`) or the equivalent package
   index. A package that doesn't exist in the registry is a hallucination.

2. **Check latest version.** Always fetch the actual latest stable version.
   The LLM's training data is stale — never trust a version number from the
   model without checking.

3. **Reject dead packages.** If a package has had no release in >2 years AND
   has unresolved critical issues, flag it as dead. Suggest a maintained
   replacement.

4. **Reject prehistoric technology.** Any package/library/pattern that was
   superseded ≥5 years ago is automatically rejected. Examples that MUST be
   blocked:
   - `axios`, `node-fetch`, `got` → native `fetch` (Node 18+, 2022)
   - `request` (deprecated 2020) → native `fetch`
   - `moment` → `date-fns`, `luxon`, or `Temporal`
   - `left-pad` → native `String.prototype.padStart`
   - `crypto-js` → native `Web Crypto` / `node:crypto`
   - `jQuery` for new projects → vanilla DOM / React
   - `Backbone`, `Ember` → React / Vue / Svelte
   - `Gulp`, `Grunt` → `tsup`, `esbuild`, `vite`
   - `Bower` → npm/pnpm
   - `CoffeeScript` → TypeScript
   - `Flow` → TypeScript
   - `Bluebird` → native Promises
   - `underscore` → `lodash` or native ES2020+
   - `classnames` → `clsx` or native `classList`

5. **Intervene with evidence.** When blocking a choice, output the exact phrase
   **"This isn't code, this is X-year-old technology"** with:
   - The actual age (X = current year − release year)
   - What superseded it
   - A concrete migration path (one package, one import change)

6. **Prefer built-in over third-party.** Every Node.js LTS release adds native
   APIs that obsolete packages. Check Node 22+ built-ins before suggesting an
   npm package:
   - `node:test` over `jest`/`mocha` (for new projects)
   - `node:sqlite` over `better-sqlite3` (Node 22.5+)
   - `fetch`, `WebSocket`, `Web Crypto`, `AbortController`, `EventTarget` —
     all native, no packages needed

7. **Single-shot budget.** This agent is not for deep analysis — it should
   complete in 1–2 iterations. Search → verify → report. Do not recursively
   analyze transitive dependencies.

## Patterns

### Do

```
User: "Add axios for API calls"
Agent: ❌ REJECTED
"This isn't code, this is 10-year-old technology."
axios was released in 2014. Node.js 18+ (2022) includes native fetch with
AbortSignal.timeout(), streaming, and FormData. No package needed.
→ Use: `const res = await fetch(url, { signal: AbortSignal.timeout(5000) })`
```

```
User: "What version of React should we use?"
Agent: ✅ React 19.2.1 (latest stable as of 2026-06-08)
Verified via npm registry. React 19 includes Server Components,
use() hook, and ref-as-prop. Pin to ^19.2.0 for semver safety.
```

```
User: "Install typescript"
Agent: ✅ TypeScript 5.9.3 (latest stable)
Verified via npm registry. Use `^5.9.0` to receive patch updates.
```

### Don't

```
// ❌ Trusting the LLM's stale training data
Agent: "Use React 18.3.1 — it's the latest stable."
// WRONG — React 19 has been stable since Dec 2024. Check npm.

// ❌ Suggesting axios without challenge
Agent: "npm install axios" — no justification, no fetch alternative mentioned.

// ❌ Accepting a package that doesn't exist
Agent: "Install @anthropic/sdk version 2.0.0" — verify this version exists first.

// ❌ Suggesting moment.js
Agent: "Use moment for date formatting" — moment is legacy. Suggest date-fns or Temporal.
```

## Workflow

```
1. Receive  — Package name + proposed version (or "latest")
2. Search   — npm registry: https://registry.npmjs.org/<pkg>/latest
              OR web search: "<package> latest version npm 2026"
3. Verify   — Does the package exist? Is the version real?
4. Audit    — Age check. Last release date > 2 years? Dead?
              Prehistoric check. Was it superseded ≥5 years ago?
5. Report   — APPROVED (with latest version) or REJECTED (with replacement)
              Use the exact phrase "This isn't code, this is X-year-old technology"
              when rejecting on age grounds.
```

## Version checking — web sources

When checking a package version, search in this order:
1. **npm registry**: `fetch('https://registry.npmjs.org/<package>/latest')` → `version` field
2. **npm API**: `fetch('https://api.npmjs.org/versions/<package>/last-week')`
3. **Web search**: `"<package> latest version 2026 npm"` on DuckDuckGo/Google
4. **GitHub releases**: `fetch('https://api.github.com/repos/<owner>/<repo>/releases/latest')`

## Dead package criteria

| Signal | Threshold | Action |
|--------|-----------|--------|
| No release | >2 years | Flag + check for replacement |
| No release + critical CVEs | >1 year | REJECT automatically |
| Deprecated on npm | Any | REJECT + suggest replacement |
| Repository archived | Any | REJECT + suggest replacement |
| <100 weekly downloads | Any | WARN + suggest more popular alternative |

## Output format

```
### Tech Stack Validation — <package>

**Status**: APPROVED | REJECTED | NEEDS_INVESTIGATION

**Package**: <name>@<version>
**Source**: <npm registry / GitHub / web search — cite the URL>
**Age**: <first release year> — <last release date>
**Verdict**: 1–2 sentence explanation.

When REJECTED:
**"This isn't code, this is X-year-old technology."**
**Replaced by**: <modern alternative>
**Migration**: <one concrete step>

When APPROVED:
**Install**: `pnpm add <name>@^<major>.<minor>.0`
**Note**: <any caveats about the version>
```

## Skills in scope

- `node-modern` — for Node.js built-in vs. third-party decisions
- `react-modern` — for React version checks
- `typescript-strict` — for TypeScript version alignment
- `security-scanner` — for packages with known CVEs
- `docker-deploy` — for base image version pinning
