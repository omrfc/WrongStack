/**
 * @wrongstack/plugins — Official WrongStack Plugin Suite
 *
 * Exported plugins (16 total):
 *  1. auto-doc         — Auto-generates JSDoc/TSDoc (dryRun for preview)
 *  2. git-autocommit  — AI-powered commit messages (git_autocommit/status_summary removed)
 *  3. shell-check     — Runs shellcheck on files or directories (merged)
 *  4. cost-tracker    — Tracks LLM token usage and estimated cost per session
 *  5. file-watcher    — Watches project files and emits events on changes
 *  6. cron            — Schedules recurring tasks via extension hooks
 *  7. template-engine — Expands file templates with variable substitution
 *  8. semver-bump     — Conventional-commit-driven semver version bumps
 *  9. secret-scanner  — Pre+post-tool hooks that block, redact, or warn
 *                        about plaintext credentials flowing into/out of tools
 * 10. todo-tracker    — Persistent, project-scoped todo backlog that
 *                        survives across sessions
 * 11. token-budget    — Enforces a per-session token budget — warns at a
 *                        threshold and stops the agent loop when the limit is hit
 * 12. lint-gate       — Pre-tool hook that runs biome/eslint on would-be
 *                        file content before write or edit commits it
 * 13. branch-guard    — Pre-tool hook that blocks commits, pushes, and
 *                        merges to protected branches (default: main, master)
 * 14. diff-summary    — Post-tool hook that injects a compact git diff
 *                        into the LLM context after every write or edit
 * 15. commit-validator — Pre-tool hook that validates conventional-commit
 *                        format before git_autocommit or bash git commit runs
 * 16. format-on-save   — Post-tool hook that runs biome format --write
 *                        on the file after every write or edit
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
export { default as secretScannerPlugin } from './secret-scanner/index.js';
export { default as todoTrackerPlugin } from './todo-tracker/index.js';
export { default as tokenBudgetPlugin } from './token-budget/index.js';
export { default as lintGatePlugin } from './lint-gate/index.js';
export { default as branchGuardPlugin } from './branch-guard/index.js';
export { default as diffSummaryPlugin } from './diff-summary/index.js';
export { default as commitValidatorPlugin } from './commit-validator/index.js';
export { default as formatOnSavePlugin } from './format-on-save/index.js';