/**
 * @wrongstack/plugins — Official WrongStack Plugin Suite
 *
 * Exported plugins (8 total):
 *  1. auto-doc         — Auto-generates JSDoc/TSDoc (dryRun for preview)
 *  2. git-autocommit  — AI-powered commit messages (git_autocommit/status_summary removed)
 *  3. shell-check     — Runs shellcheck on files or directories (merged)
 *  4. cost-tracker    — Tracks LLM token usage and estimated cost per session
 *  5. file-watcher    — Watches project files and emits events on changes
 *  6. cron            — Schedules recurring tasks via extension hooks
 *  7. template-engine — Expands file templates with variable substitution
 *  8. semver-bump     — Conventional-commit-driven semver version bumps
 *
 * Removed (use the equivalent built-in tools instead — see
 * `DEPRECATED_PLUGIN_NAMES` in `packages/cli/src/wiring/plugins.ts`
 * for the loader-level migration warning):
 *  - web-search      → built-in `search` + `fetch`
 *  - json-path       → built-in `json` tool (action: query|validate|transform|merge)
 *
 * Usage in WrongStack config:
 * ```json
 * {
 *   "plugins": {
 *     "auto-doc": { "enabled": true },
 *     "git-autocommit": { "conventionalCommits": true }
 *   }
 * }
 * ```
 */

export { default as autoDocPlugin } from './auto-doc/index.js';
export { default as gitAutocommitPlugin } from './git-autocommit/index.js';
export { default as shellCheckPlugin } from './shell-check/index.js';
export { default as costTrackerPlugin } from './cost-tracker/index.js';
export { default as fileWatcherPlugin } from './file-watcher/index.js';
export { default as cronPlugin } from './cron/index.js';
export { default as templateEnginePlugin } from './template-engine/index.js';
export { default as semverBumpPlugin } from './semver-bump/index.js';