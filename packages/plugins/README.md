# @wrongstack/plugins

First-party plugin collection for [WrongStack](https://github.com/WrongStack/WrongStack).
Fourteen focused, single-purpose plugins ship in this package and load
automatically for every `wstack` session.

## What this is

Each plugin is a self-contained ESM module under `src/<name>/` that
exports a default `Plugin` object. The host's plugin loader
(`@wrongstack/core/plugin/loader`) accepts, validates, and
`setup()`s them. Plugins register **tools** on the host's
`ToolRegistry` and may also register **hooks** (e.g.
`secret-scanner` registers `PreToolUse` + `PostToolUse` hooks).

Plugins are loaded lazily by `packages/cli/src/wiring/plugins.ts`
under the `BUILTIN_PLUGIN_FACTORIES` array. To opt out, add
`{ name: '<plugin>', enabled: false }` to `config.plugins`.

## Plugin catalog

| # | Plugin | Tools | Hooks | Notes |
|---|---|---|---|---|
| 1 | [`auto-doc`](./src/auto-doc) | `auto_doc` | — | JSDoc/TSDoc generation with `dry_run` preview |
| 2 | [`git-autocommit`](./src/git-autocommit) | `git_autocommit` | — | AI-written conventional commits; warns on simultaneous worktrees |
| 3 | [`shell-check`](./src/shell-check) | `shellcheck` | — | Runs `shellcheck` on files OR directories (recursive scan) |
| 4 | [`cost-tracker`](./src/cost-tracker) | `cost_summary`, `cost_reset`, `cost_export` | — | Per-model token + USD tracking; reads from `api.modelsRegistry` (models.dev) with a `pricingOverrides` config escape hatch |
| 5 | [`file-watcher`](./src/file-watcher) | `watch_start`, `watch_stop`, `watch_list` | — | Filesystem event hook (chokidar); feeds the `dep-watcher` bridge in the CLI |
| 6 | [`cron`](./src/cron) | `cron_schedule`, `cron_list`, `cron_cancel` | — | In-session recurring tasks; lifecycle via `beforeIteration` |
| 7 | [`template-engine`](./src/template-engine) | `template_expand`, `template_render`, `template_create`, `template_list` | — | Handlebars-style `{{var}}`, `{{#if}}`, `{{#each}}` |
| 8 | [`semver-bump`](./src/semver-bump) | `semver_bump`, `semver_current`, `semver_changelog` | — | Conventional-commit → semver version bump; can tag |
| 9 | [`secret-scanner`](./src/secret-scanner) | `secret_scanner_status`, `secret_scanner_test` | `PreToolUse` (`bash\|write\|edit`) + `PostToolUse` (`*`) | Blocks/redacts input secrets; warns on output leaks |
| 10 | [`todo-tracker`](./src/todo-tracker) | `todo_tracker_list/add/complete/drop/remove/pull/status` | — | Persistent project-scoped backlog that survives across sessions; cross-session bridge via `todo_tracker_pull` |
| 11 | [`token-budget`](./src/token-budget) | `token_budget_status` | `Stop` | Enforces a per-session token budget — warns at `warnPercent`, stops agent loop at `stopPercent` |
| 12 | [`lint-gate`](./src/lint-gate) | `lint_gate_status` | `PreToolUse` (`write\|edit`) | Runs biome/eslint on would-be file content before write or edit commits; blocks or warns on lint issues |
| 13 | [`branch-guard`](./src/branch-guard) | `branch_guard_status` | `PreToolUse` (`bash\|git_autocommit`) | Blocks commits, pushes, and merges to protected branches (default: main, master) |
| 14 | [`diff-summary`](./src/diff-summary) | `diff_summary_status` | `PostToolUse` (`write\|edit`) | Injects compact git diff into LLM context after every write or edit |

### Removed plugins (use built-in tools instead)

| Removed | Replacement | Why |
|---|---|---|
| `web-search` (removed in `e03e39d1`) | Built-in `search` + `fetch` tools in `@wrongstack/tools` | The built-in tools have native caching, dedup, ranking, DNS-pinned SSRF protection, TurndownService markdown, binary-content rejection, and structured errors. |
| `json-path` (removed in `e03e39d1`) | Built-in `json` tool in `@wrongstack/tools` (action: `query` \| `validate` \| `transform` \| `merge`) | The built-in `json` tool already supports JMESPath queries, schema validation, transforms, and deep-merge via a single `action` parameter. |

If a user lists either name in `config.plugins`, the loader emits a
one-shot `log.warn` and skips loading. See
[`DEPRECATED_PLUGIN_NAMES`](../../cli/src/wiring/plugins.ts)
in `packages/cli/src/wiring/plugins.ts` for the canonical list and
migration hints.

## Per-plugin quick reference

### 1. `auto-doc` — JSDoc/TSDoc generation

**Tools**: `auto_doc` (mutating)

Generates JSDoc/TSDoc comments and either writes them to the file or
returns a preview. Pass `dry_run: true` to see what would change
without writing — the same tool, no separate preview tool.

```jsonc
// Generate doc comments for every export in src/agent.ts, preview only
auto_doc({ files: ["src/agent.ts"], style: "tsdoc", dry_run: true })
```

### 2. `git-autocommit` — AI commit messages

**Tools**: `git_autocommit` (mutating, `confirm` permission)

Stages the listed files (or all changed files when `files: []`) and
creates a commit with a conventional-commit message derived from the
diff. Warns when other worktrees are active (likely parallel agents
editing the same repo) so the user can verify the diff before commit.

```jsonc
git_autocommit({ type: "fix", scope: "session", message: "..." })
```

### 3. `shell-check` — bash script linting

**Tools**: `shellcheck` (mutating — writes the CSV report)

Two modes: pass `files: ['scripts/deploy.sh']` to lint specific files
or `directory: 'scripts', pattern: '*.sh'` to recursively scan.

### 4. `cost-tracker` — token + USD tracking

**Tools**: `cost_summary`, `cost_reset`, `cost_export`

Listens to the `provider.response` event, computes cost from the
models.dev-backed `api.modelsRegistry` (Layer 2 of the lookup chain),
with a bundled `PRICING` table as the baseline (Layer 3) and a
`pricingOverrides` config field as the top-priority escape hatch
(Layer 1). The `pricingOverrides` field is the user-facing tool for
correcting a specific model's price without waiting for a plugin
release. See [cost-tracker source](./src/cost-tracker/index.ts) for
the full lookup chain.

```jsonc
// Per-model override (USD per 1M tokens, lowercased model id)
{
  "extensions": {
    "cost-tracker": {
      "pricingOverrides": {
        "gpt-4o": { "input": 7, output: 21 },
        "claude-3-5-sonnet": { "input": 4, output: 20 }
      }
    }
  }
}
```

### 5. `file-watcher` — filesystem events

**Tools**: `watch_start`, `watch_stop`, `watch_list`

Wires `node:fs.watch` listeners and stores the handles in module
scope. The CLI hooks these events to the per-project mailbox via
the `dep-watcher` bridge so dependency-manifest changes
(`package.json`, `go.mod`, etc.) trigger tech-stack audits.

### 6. `cron` — in-session recurring tasks

**Tools**: `cron_schedule`, `cron_list`, `cron_cancel`

Schedules timers with `api.extensions.register('beforeIteration', ...)`.
All timers are tracked in module-scope state and torn down on plugin
unload so a hot-reload cycle doesn't leak `setTimeout` handles
(audited 2026-06-03, see "H1 audit pattern" below).

### 7. `template-engine` — file templates

**Tools**: `template_expand`, `template_render`, `template_create`, `template_list`

Three template forms: `{{var}}` substitution, `{{#if var}}…{{/if}}`
conditionals, `{{#each items}}…{{/each}}` loops. The store is in-memory
and module-scoped (audited 2026-06-03).

### 8. `semver-bump` — conventional commits → version

**Tools**: `semver_bump`, `semver_current`, `semver_changelog`

Reads the git log since the last tag, infers the next version
(major/minor/patch) from the conventional-commit types, and can
tag the new commit. `changelog` generates a markdown changelog
between two refs.

### 9. `secret-scanner` — credential blocker + output leak detector

**Tools**: `secret_scanner_status`, `secret_scanner_test`
**Hooks**:
- `PreToolUse` with matcher `bash|write|edit` (configurable via `matcher`)
- `PostToolUse` with matcher `*` (configurable via `postToolUseMatcher`)

**PreToolUse** (prevention — before the tool runs):
Mirrors 21 simple patterns from `core/src/security/secret-scrubber.ts`
(LLM provider keys, GitHub PATs v1+v2, AWS, GCP, Slack, Stripe,
Twilio, Telegram, JWT, PEM private keys, HuggingFace/Replicate/
Perplexity/Groq, Bearer tokens, mongo/postgres/mysql/redis URIs).
Read-only tools (`read`, `fetch`) are excluded from PreToolUse by
default since secrets flowing IN to them are fine.

**PostToolUse** (detection — after the tool runs):
Scans tool OUTPUT for secrets that leaked through. Since the tool
has already run, the hook cannot block — instead it injects
`additionalContext` so the LLM knows not to echo, store, or commit
the leaked value.

Three modes (`config.extensions['secret-scanner'].mode`):
- **`block` (default)**: returns `HookOutcome{ decision: 'block', reason }`
- **`redact`**: returns `HookOutcome{ decision: 'allow', modifiedInput, additionalContext }` with the offending strings replaced by `[REDACTED:type]`
- **`allow`**: only logs; never blocks

```jsonc
// Basic config
{
  "extensions": {
    "secret-scanner": {
      "mode": "block",
      "matcher": "bash|write|edit",
      "postToolUseMatcher": "*"
    }
  }
}
```

**Custom patterns** (`customPatterns`): Append your own credential
patterns alongside the 21 built-in ones. Each entry is a
`{ type, regex, description? }`. Invalid regex entries are silently
skipped.

```jsonc
{
  "extensions": {
    "secret-scanner": {
      "customPatterns": [
        {
          "type": "internal_api_key",
          "regex": "IAK-[A-F0-9]{40}",
          "description": "Internal API key format"
        },
        {
          "type": "custom_jwt",
          "regex": "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"
        },
        {
          "type": "vault_token",
          "regex": "hvs\\.[A-Za-z0-9_-]{90,}"
        }
      ]
    }
  }
}
```

Custom patterns are detected by all hooks (PreToolUse block/redact,
PostToolUse leak detection) and by the `secret_scanner_test` tool.
They are reset to base-only on teardown (H1 pattern).

The `high_entropy_env` pattern from the output scrubber is
intentionally omitted — too slow and too false-positive prone
for a synchronous pre-tool gate.

### 10. `todo-tracker` — persistent backlog

**Tools**: `todo_tracker_list`, `todo_tracker_add`, `todo_tracker_complete`, `todo_tracker_drop`, `todo_tracker_remove`, `todo_tracker_pull`, `todo_tracker_status`

Closes a gap that no existing tool fills: a **per-project backlog**
that survives across sessions. The built-in `todo` tool mutates
`ctx.todos` (session-scoped, auto-clears when all items complete);
`PlanFile` and `TaskFile` are also session-scoped. This plugin
writes a per-project JSON file with atomic write (temp + rename).

**Cross-session bridge**: `todo_tracker_pull` returns active items
for the LLM to re-register with the built-in `todo` tool (which
mutates `ctx.todos`). The plugin never touches `ctx.todos` directly
— that separation respects the existing session/tool boundary.

**Storage**: per-project JSON at the path provided by
`paths.projectDir` (via the host's wiring) or via the explicit
`config.extensions["todo-tracker"].filePath` config field.

```jsonc
// Explicit override (use when the host doesn't supply paths.projectDir)
{
  "extensions": {
    "todo-tracker": {
      "filePath": "/abs/path/to/todo-tracker.json"
    }
  }
}
```

### 11. `token-budget` — per-session token enforcement

**Tools**: `token_budget_status`
**Hooks**: `Stop` + `PostToolUse` (matcher `*`)

Complements `cost-tracker` (which tracks cost in USD) by enforcing a
**hard token budget**. When usage crosses `warnPercent`, a one-shot
`PostToolUse` injection tells the LLM to start wrapping up. When it
crosses `stopPercent`, the `Stop` hook blocks the agent loop.

```jsonc
{
  "extensions": {
    "token-budget": {
      "limit": 500000,       // hard token limit (prompt + completion)
      "warnPercent": 80,     // inject "wrap up" at this %
      "stopPercent": 100,    // trigger Stop at this %
      "model": ""            // "" = all models; or restrict to one
    }
  }
}
```

`limit: 0` (default) = tracking only (no enforcement). The
`token_budget_status` tool reports the exact consumed/remaining
breakdown.

### 12. `lint-gate` — pre-write lint enforcement

**Tools**: `lint_gate_status`
**Hooks**: `PreToolUse` (matcher `write|edit`)

Runs biome (or eslint) on the would-be file content **before** the
write or edit commits it. For `write`, the full content is linted
via a temp file. For `edit`, the current file is read, the
`old_string → new_string` replacement is applied in-memory, and the
result is linted.

```jsonc
{
  "extensions": {
    "lint-gate": {
      "linter": "auto",       // "biome" | "eslint" | "auto"
      "mode": "warn",         // "block" | "warn" | "fix"
      "severity": "error",    // "error" | "warning"
      "timeoutMs": 10000,     // linter process timeout
      "fixRules": []          // when mode=fix, limit auto-fix to these rules only
    }
  }
}
```

**Modes**:
- **`block`**: refuses the write/edit; LLM must fix lint errors first
- **`warn`** (default): injects lint errors as context; write proceeds
- **`fix`**: auto-runs `biome check --write` / `eslint --fix`, substitutes
  the fixed content via `modifiedInput` (`write` only; `edit` falls back
  to `warn`). Use `fixRules` to limit which rules are auto-fixed:

```jsonc
// Only auto-fix formatting and import types; leave noExplicitAny as warning
{
  "extensions": {
    "lint-gate": {
      "mode": "fix",
      "fixRules": ["format", "lint/style/useImportType"]
    }
  }
}
```

### 13. `branch-guard` — protected branch enforcement

**Tools**: `branch_guard_status`
**Hooks**: `PreToolUse` (matcher `bash|git_autocommit`)

Blocks `git commit`, `git push`, and `git merge` on protected branches
(default: `main`, `master`). Checks the current branch via
`git branch --show-current`. When the working tree is dirty, the
block reason includes a safe stash workflow:

```
git stash → git checkout -b feat/my-change → git stash pop → git commit ...
```

```jsonc
{
  "extensions": {
    "branch-guard": {
      "branches": ["main", "master", "release/*"],
      "mode": "block",         // "block" | "warn"
      "blockCommit": true,
      "blockPush": true,
      "blockMerge": true
    }
  }
}
```

Each operation type can be individually toggled. `git_autocommit`
tool calls are treated as commits.

### 14. `diff-summary` — post-write/edit diff injection

**Tools**: `diff_summary_status`
**Hooks**: `PostToolUse` (matcher `write|edit`)

After every `write` or `edit` completes, runs `git diff -- <path>`
and injects a capped unified diff into the LLM's context as
`additionalContext`. Gives the LLM immediate visibility into what its
change actually did to the file — confirming the edit applied correctly
and showing surrounding context.

```jsonc
{
  "extensions": {
    "diff-summary": {
      "maxLines": 50,       // cap diff context at N lines
      "showStat": true,     // include "+N -M" summary line
      "mode": "diff"        // "diff" | "stat" | "off"
    }
  }
}
```

**Modes**:
- **`diff`** (default): injects unified diff body (capped at `maxLines`) + `+N -M` header
- **`stat`**: injects only `+N -M` counts (no diff body)
- **`off`**: disabled entirely

For untracked/new files: uses `git diff --no-index /dev/null <path>`.
For non-git repos: silent fallback (no injection). Skips on tool errors.

## Configuration patterns

There are two surfaces for plugin configuration:

1. **Loading** — `config.plugins` controls which plugins load.
   ```jsonc
   {
     "plugins": [
       { "name": "auto-doc", "enabled": true },
       { "name": "git-autocommit", "options": { "conventionalCommits": true } }
     ]
   }
   ```
2. **Options** — `config.extensions["<plugin-name>"]` stores each
   plugin's runtime options. The plugin's `configSchema` validates
   this section before `setup()` runs.

```jsonc
{
  "plugins": {
    "auto-doc": { "enabled": true },
    "git-autocommit": { "conventionalCommits": true },
    "secret-scanner": { "mode": "block", "matcher": "bash|write|edit" }
  }
}
```

To disable a single built-in without removing its config:
```jsonc
{ "plugins": [{ "name": "secret-scanner", "enabled": false }] }
```

## H1 audit pattern

Plugins that hold module-scope state (`cron`, `file-watcher`,
`template-engine`, `git-autocommit`, `cost-tracker`, `secret-scanner`,
`todo-tracker`, `auto-doc`, `shell-check`, `semver-bump`,
`token-budget`, `lint-gate`, `branch-guard`, `diff-summary`) follow a strict lifecycle to survive hot-reload
without leaking resources. The pattern was formalized after a
2026-06-03 audit (the "H1 audit") found that several plugins kept
their state inside the `setup()` closure, where the loader's
`WeakMap<Plugin, PluginAPI>` could not reach it during teardown —
meaning timers, filesystem handles, and in-memory caches leaked
across plugin reloads.

The H1 pattern:

1. **State at module scope, not in setup() closure.** Anything the
   `teardown` needs to clean up lives in a `const state = {…}` block
   next to the `Plugin` object.
2. **`setup()` is idempotent.** It clears the state first, then
   re-initializes from config and the host's API. Calling `setup()`
   twice (e.g. across a hot-reload) leaves a clean slate.
3. **`teardown()` releases every resource.** Timers are `clearTimeout`'d,
   chokidar watchers are `close()`'d, caches are cleared. The
   unregister handle returned by `api.registerHook` is called.
4. **`teardown` does not delete on-disk state.** File-based plugins
   (e.g. `todo-tracker`) leave the file in place — the user may
   return in a moment to read it.
5. **`health()` reports per-session counters** for `/diag plugins`
   visibility.

Plugins that follow this pattern expose the same teardown contract
to the host, so the loader can clean up uniformly.

## For plugin authors

The minimum viable plugin:

```typescript
import type { Plugin } from '@wrongstack/core';

const plugin: Plugin = {
  name: 'my-plugin',
  version: '0.1.0',
  description: 'One-line summary shown in `wstack plugins list`',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: {},
  configSchema: {
    type: 'object',
    properties: { /* … */ },
  },
  setup(api) {
    api.tools.register({
      name: 'my_tool',
      description: 'What this tool does',
      inputSchema: { type: 'object', properties: { /* … */ } },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        return { ok: true };
      },
    });
    api.log.info('my-plugin loaded', { version: '0.1.0' });
  },
  teardown(api) {
    // If you hold state, clear it here (see H1 pattern).
    api.log.info('my-plugin: teardown complete');
  },
  async health() {
    return { ok: true, message: 'my-plugin: alive' };
  },
};

export default plugin;
```

Register the entry in `tsup.config.ts`, the subpath export in
`package.json#exports`, and the named re-export in `src/index.ts`.
Wire it into the CLI's `BUILTIN_PLUGIN_FACTORIES` if it should
auto-load.

For plugins that need host-level data not yet exposed in
`PluginAPI` (e.g. `paths.projectDir`), extend the type in
`packages/core/src/types/plugin.ts` and `PluginAPIInit` in
`packages/core/src/plugin/api.ts`, then thread it through
`DefaultPluginAPI` and the wiring layer. See how `modelsRegistry`
was added for `cost-tracker` (commit `9bed619f`).

## License

MIT — see top-level [`LICENSE`](../../LICENSE).
