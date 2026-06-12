# /semver - Version Bump Control

## What It Does

`/semver` is registered by the builtin **semver-bump** plugin and gives the
user direct, explicit control over version bumps — instead of the agent
calling the `semver_bump` tool with a mode it picked itself.

Without arguments it is read-only: it prints the current `package.json`
version, the latest git tag, the number of commits since that tag, and the
bump that conventional-commit analysis would suggest. Nothing is written.

With a mode argument it applies the bump:

1. Updates **every** manifest that shares the repo version. If the repo has
   `scripts/bump-version.mjs` (the lockstep entry point — root + all
   workspace packages + website files), the plugin delegates to it. Otherwise
   it writes the root `package.json` plus every `packages/*/package.json`
   and `apps/*/package.json` it finds.
2. Commits exactly the files it touched (`chore: bump version to <X>`).
3. Creates an annotated tag (`v<X>`, unless `autoTag` is disabled in the
   plugin config).

## Usage

| Usage | Effect |
|---|---|
| `/semver` | Show current version, latest tag, and suggested bump (read-only) |
| `/semver status` | Same as bare `/semver` |
| `/semver patch` | Bump the patch version (commit + tag) |
| `/semver minor` | Bump the minor version (commit + tag) |
| `/semver major` | Bump the major version (commit + tag) |
| `/semver auto` | Infer the bump from conventional commits since the last tag |
| `/semver <part> --dry` | Preview the bump without writing anything |

`auto` returns `major` only for breaking commits (`feat!:`, `feat(scope)!:`),
`minor` when at least one `feat:` commit exists since the last tag, and
`patch` otherwise.

## Notes

- The `semver_bump` *tool* falls back to the configured default part when the
  model omits `part` (factory default: `patch` — it never silently runs commit
  analysis). Change it with `/settings semver-part patch|minor|major|auto`;
  the value persists to `extensions["semver-bump"].defaultPart` in the global
  config and applies without a restart. `/semver status` shows the active
  default.
- Plugin config (`tagPrefix`, `autoTag`, `defaultPart`, …) lives under the
  `semver-bump` key in `~/.wrongstack/config.json` extensions.
- The plugin also registers the read-only `semver_current` and
  `semver_changelog` tools.
