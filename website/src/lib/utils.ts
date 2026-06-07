import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* =========================================================================
   Site data — every value below is sourced from the WrongStack codebase
   (README.md / AGENTS.md / package manifests). No invented numbers.
   ========================================================================= */

export const META = {
  version: '0.89.1',
  repo: 'https://github.com/WrongStack/WrongStack',
  npm: 'wrongstack',
  node: '22',
  license: 'MIT',
  domain: 'wrongstack.com',
} as const;

export const heroStats = [
  { value: '36', label: 'built-in tools' },
  { value: '16', label: 'bundled skills' },
  { value: '~110', label: 'model providers' },
  { value: '10', label: 'official plugins' },
] as const;

/** 16 bundled skills — README / bundled catalog canonical list. */
export const skills = [
  { name: 'api-design', description: 'REST conventions, pagination, auth, and error taxonomy' },
  { name: 'audit-log', description: 'Analyze session logs and event streams' },
  { name: 'bug-hunter', description: 'Systematic debugging and anti-pattern detection' },
  { name: 'docker-deploy', description: 'Container builds, non-root images, and deployment checks' },
  { name: 'git-flow', description: 'Branching strategy and commit conventions' },
  { name: 'multi-agent', description: 'Coordinate parallel agent workflows' },
  { name: 'node-modern', description: 'Node.js 22+ patterns and best practices' },
  { name: 'observability', description: 'Structured logs, traces, metrics, and redaction' },
  { name: 'prompt-engineering', description: 'Craft effective prompts for better results' },
  { name: 'react-modern', description: 'React 19+ patterns and hooks' },
  { name: 'refactor-planner', description: 'Plan and execute safe refactors' },
  { name: 'sdd', description: 'Spec-Driven Development workflow' },
  { name: 'security-scanner', description: 'Find vulnerabilities before they ship' },
  { name: 'skill-creator', description: 'Build custom skills for specialized tasks' },
  { name: 'testing', description: 'Vitest patterns, mocks, coverage, and test strategy' },
  { name: 'typescript-strict', description: 'Strict TypeScript for bulletproof code' },
] as const;

/** The 36 built-in tools, grouped. */
export const toolGroups = [
  {
    label: 'Files',
    tools: ['read', 'write', 'edit', 'replace', 'glob', 'grep', 'tree', 'patch', 'diff'],
  },
  { label: 'Shell', tools: ['bash', 'exec'] },
  { label: 'Web', tools: ['fetch', 'search'] },
  { label: 'Quality', tools: ['lint', 'format', 'typecheck', 'test'] },
  { label: 'Packages', tools: ['install', 'audit', 'outdated'] },
  { label: 'Codegen', tools: ['document', 'scaffold'] },
  { label: 'Data', tools: ['json', 'logs'] },
  { label: 'Project', tools: ['git', 'todo'] },
  { label: 'Codebase index', tools: ['codebase-index', 'codebase-search', 'codebase-stats'] },
  { label: 'Memory', tools: ['remember', 'forget'] },
  {
    label: 'Meta-tooling',
    tools: ['tool_search', 'tool_use', 'batch_tool_use', 'tool_help', 'context_manager'],
  },
] as const;

/** Provider wire families — from models.dev, no hardcoded models or pricing. */
export const providerFamilies = [
  {
    id: 'anthropic',
    transport: 'Native Claude API + SSE',
    examples: ['Anthropic', 'MiniMax', 'Kimi', 'Vertex (Anthropic)'],
  },
  {
    id: 'openai',
    transport: 'OpenAI Chat Completions + SSE',
    examples: ['OpenAI', 'Perplexity', 'Vivgrid'],
  },
  {
    id: 'openai-compatible',
    transport: 'OpenAI-spec endpoints + SSE',
    examples: [
      'Mistral',
      'Groq',
      'DeepSeek',
      'OpenRouter',
      'Together',
      'xAI',
      'Cerebras',
      'Ollama',
      'Fireworks',
      'Moonshot',
      'GLM',
      'Alibaba',
    ],
  },
  {
    id: 'google',
    transport: 'Gemini streamGenerateContent (SSE)',
    examples: ['Google AI Studio'],
  },
] as const;

/** Real slash commands shipped in packages/cli/src/slash-commands. */
export const slashCommands = [
  '/acp',
  '/agents',
  '/audit',
  '/autonomy',
  '/autophase',
  '/btw',
  '/clear',
  '/codebase-reindex',
  '/collab',
  '/commit',
  '/compact',
  '/context',
  '/diag',
  '/director',
  '/enhance',
  '/fix',
  '/fleet',
  '/goal',
  '/health',
  '/help',
  '/image',
  '/init',
  '/mcp',
  '/memory',
  '/metrics',
  '/mode',
  '/model',
  '/models',
  '/plan',
  '/plugin',
  '/queue',
  '/replay',
  '/resume',
  '/save',
  '/sdd',
  '/security',
  '/setmodel',
  '/settings',
  '/skill',
  '/skills',
  '/skill-gen',
  '/spawn',
  '/stats',
  '/statusline',
  '/steer',
  '/sync',
  '/telegram',
  '/telegram-setup',
  '/tools',
  '/todos',
  '/usage',
  '/version-help',
  '/worktree',
  '/yolo',
] as const;

/** Published packages (subpath workspaces). */
export const packages = [
  '@wrongstack/core',
  '@wrongstack/cli',
  '@wrongstack/providers',
  '@wrongstack/tools',
  '@wrongstack/mcp',
  '@wrongstack/plug-lsp',
  '@wrongstack/runtime',
  '@wrongstack/tui',
  '@wrongstack/webui',
  '@wrongstack/telegram',
  '@wrongstack/plugins',
  '@wrongstack/skills',
] as const;

/** 10 official plugins — README plugin table. */
export const plugins = [
  { name: 'auto-doc', note: 'JSDoc / TSDoc generation' },
  { name: 'git-autocommit', note: 'Conventional-commit messages' },
  { name: 'shell-check', note: 'ShellCheck wrapper' },
  { name: 'cost-tracker', note: 'Token + cost per model' },
  { name: 'file-watcher', note: 'Emits file-change events' },
  { name: 'web-search', note: 'Cached search + URL→markdown' },
  { name: 'json-path', note: 'JSONPath query & mutate' },
  { name: 'cron', note: 'Recurring actions via hooks' },
  { name: 'template-engine', note: '{{var}} / {{#if}} / {{#each}}' },
  { name: 'semver-bump', note: 'Commit-driven version bumps' },
] as const;

/* =========================================================================
   Changelog — source: CHANGELOG.md. Each entry has version, date, tagline,
   and key highlights.
   ========================================================================= */

export interface ChangelogEntry {
  version: string;
  date: string;
  tagline: string;
  highlights: string[];
  /** If true, this release consolidated intermediate bump-only versions. */
  consolidated?: boolean;
  /** If true, marks the latest release. */
  latest?: boolean;
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.87.0',
    date: '2026-06-07',
    latest: true,
    tagline: 'Session lifecycle & type safety',
    consolidated: true,
    highlights: [
      '/prune session housekeeping — delete old sessions by age, --dry-run preview, --rebuild-index',
      'Analytics-grade session summaries: iteration/tool/error/file-change counts, per-tool breakdown, outcome',
      'Categorized slash-command discovery — grouped TUI picker, WebUI command list 19 → 39',
      'Non-modal TUI monitor overlays — chat input stays live while monitors are open',
      'fetch undici dispatcher torn down on exit; session-store teardown race fixed (Windows ENOTEMPTY)',
      'Monorepo-wide type-safety hardening (exactOptionalPropertyTypes), MCP undici@7 type conflict resolved',
    ],
  },
  {
    version: '0.77.0',
    date: '2026-06-06',
    tagline: 'Prompt refinement & hardening',
    highlights: [
      'LLM-driven /enhance prompt refinement with countdown auto-send preview in the TUI',
      '/telegram-setup one-command bot configuration against the Telegram getMe API',
      'Live concurrency ceiling in TUI fleet monitor with kernel event subscription',
      'Project-root detection hardened — stops walk-up at homedir, prunes stale project dirs',
      'TUI input fixes: Delete/Backspace separation, Shift+Enter multi-line insert',
      '3 new TUI surfaces: CompactTodosPanel, QueuePanel, TodosMonitor',
      'pnpm 11.3.0 → 11.5.2, human-readable project directory naming',
    ],
  },
  {
    version: '0.73.1',
    date: '2026-06-06',
    tagline: 'Background indexer & decomposition',
    consolidated: true,
    highlights: [
      'Background, gitignore-aware SQLite codebase indexer with /codebase-reindex command',
      'Large-file decomposition pass: 16 monoliths → 55 focused submodules (WebUI store/WS/sidebar, TUI app)',
      'TUI mouse mode removed entirely — unreliable on Windows consoles',
      'Node 23.9 → 24.0 migration, expanded pre-launch readiness checks',
    ],
  },
  {
    version: '0.66.13',
    date: '2026-06-05',
    tagline: 'WebUI fleet & agent decomposition',
    consolidated: true,
    highlights: [
      'Agent loop decomposed: 1,064-line core/agent.ts monolith → 6 focused, independently-testable modules',
      'WebUI multi-instance with auto-advancing ports, self-healing instance registry',
      'WebUI visual overhaul — "Engineering Instrument Deck" design system with dark/light modes',
      'Live fleet roster in WebUI: per-subagent iteration/tool/cost counters, context-fill bar',
      '/yolo destructive toggle — keep YOLO for routine work, confirm risky operations',
      'createToolOutputSerializer: budget-capped tool-output serialization',
    ],
  },
  {
    version: '0.54.1',
    date: '2026-06-04',
    tagline: 'Boot refresh & model picker',
    consolidated: true,
    highlights: [
      'Blocking models.dev catalog refresh on boot — TUI and model resolution always see fresh data',
      'Type-to-search model picker with scroll-window navigation, capped at 10 visible items',
      'WebUI secret redaction before WebSocket broadcast (DefaultSecretScrubber)',
      'Cloud-sync path-traversal guard, edit tool double-edit stale-read fix',
      'wstack models --search --page --per-page pagination',
    ],
  },
  {
    version: '0.51.3',
    date: '2026-06-04',
    tagline: 'Brain-governed AutoPhase',
    highlights: [
      'BrainArbiter coordination layer — policy decisions escalate unsafe choices to human via TUI',
      'TUI Brain decision prompt: interactive A/B/C panel with Esc/D safe default',
      'AutoPhase conflict resolution routed through Brain before merge',
      'Phase completion and worktree integration tracked separately',
      'Director budget-extension policy hooks consult Brain at soft limits',
    ],
  },
  {
    version: '0.41.0',
    date: '2026-06-03',
    tagline: 'Model matrix & AutoPhase verification gate',
    consolidated: true,
    highlights: [
      'Per-task model matrix + /setmodel slash command — different roles run on different models',
      'AutoPhase verification gate + auto-repair: verifyPhase callback retries up to maxVerifyAttempts',
      'Unified TTY / stdout abstraction layer (isStdoutTTY, writeOut, writeErr)',
      'WebUI server decomposition, CLI index.ts split into 5 modules',
      '4 critical/high audit findings resolved — argument injection blocked across 4 tools',
    ],
  },
  {
    version: '0.31.1',
    date: '2026-06-03',
    tagline: 'Director resilience',
    consolidated: true,
    highlights: [
      'LargeAnswerStore + ask_result tool — bounded Director context, 2K-char threshold for out-of-band storage',
      'Calibrated token estimation — self-corrects estimate-vs-actual ratio from provider usage',
      'Fleet failure taxonomy surfaced in TUI agents monitor and fleet timeline',
      'Director resource leak fixes: remove() frees manifest entries, task owners, nickname slots',
      'Orphaned pending tasks no longer hang awaitTasks() — synthetic stopped completions',
    ],
  },
  {
    version: '0.24.0',
    date: '2026-06-03',
    tagline: 'Version-line realignment',
    highlights: [
      'All 15 workspace manifests consolidated to single 0.24.0 lockstep version',
      'Tag history reset to single v0.24.0 — prior tags (v0.10.2–v0.28.0) deleted',
      'Intermediate bump-only versions (0.11.0–0.23.1) collapsed into this entry',
    ],
  },
  {
    version: '0.10.3',
    date: '2026-06-02',
    tagline: 'Lockstep workspace alignment',
    highlights: [
      'All workspace packages bumped to 0.10.3 in lockstep',
    ],
  },
  {
    version: '0.9.20',
    date: '2026-06-01',
    tagline: 'The collaboration release',
    highlights: [
      'Collaborative debugging — multi-human sessions (observer, annotator, controller roles)',
      'Deterministic replay — record/replay/auto modes, byte-for-byte equality',
      'Stateful session recovery — crash markers, in_flight_start/end events, /resume --incomplete',
      'Chained SHA-256 tool-call audit trail — tamper-evident, verify(sessionId) check',
      '4 IDEAS.md items shipped: collab debug, replay, recovery, audit',
    ],
  },
  {
    version: '0.8.4',
    date: '2026-05-28',
    tagline: 'AutoPhase — autonomous phase workflow',
    highlights: [
      '/autophase command: start/pause/resume/stop/status/list/load/save',
      'Ordered phases: Discovery → Design → Implementation → Testing → Deployment',
      'WebSocket-driven AutoPhase view in the web UI',
      'TUI input and status bar pinned to bottom fix',
      'Compaction overhead accounting corrected',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-05-25',
    tagline: 'Eternal autonomy & SDD',
    highlights: [
      '/autonomy eternal — run-until-done engine with decide → execute → reflect loop',
      'Persistent /goal system with pause/resume, goalState lifecycle, journal ring buffer',
      'Spec-Driven Development workflow: parse → analyze → generate → track → execute',
      '46-agent fleet roster with smart dispatcher routing',
      'Delegate budgets raised 10×, maxConcurrent 2 → 8',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-05-22',
    tagline: 'Eternal autonomy engine',
    highlights: [
      'EternalAutonomyEngine class — idle → running → stopped state machine',
      '/goal command unified: set, clear, journal subcommands',
      'TUI eternal stage chip: ⟳ DECIDE → ⚡ EXECUTE → ◎ REFLECT',
      '/autonomy eternal + --eternal flag',
      'WebUI eternal.iteration WS broadcast',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-05-21',
    tagline: 'First tagged release',
    highlights: [
      'Initial public release',
      'pnpm workspace monorepo with lockstep versioning',
      'CLI, TUI, WebUI, MCP client, providers, tools, skills, plugins',
    ],
  },
];

/* =========================================================================
   Release process — source: RELEASE.md
   ========================================================================= */

export interface ReleaseStep {
  phase: string;
  steps: string[];
}

export const releaseProcess: ReleaseStep[] = [
  {
    phase: 'Pre-release',
    steps: [
      'pnpm test — all tests green',
      'pnpm typecheck — clean tsc --noEmit',
      'pnpm lint — Biome clean',
      'pnpm build — all packages build',
      'node scripts/publish-check.mjs --dry-run',
    ],
  },
  {
    phase: 'Version bump',
    steps: [
      'node scripts/bump-version.mjs <patch|minor|major>',
      'Version bumped in all 15 workspace packages + website/',
      'CHANGELOG.md updated with release date and highlights',
    ],
  },
  {
    phase: 'Commit & tag',
    steps: [
      'git commit -am "release: X.Y.Z"',
      'git tag vX.Y.Z',
      'git push --follow-tags',
    ],
  },
  {
    phase: 'Verify CI',
    steps: [
      'GitHub Actions Release workflow triggered by tag push',
      'All 3 platforms green: Ubuntu, macOS, Windows',
      'npm packages published to all workspace subpaths',
    ],
  },
  {
    phase: 'Post-release',
    steps: [
      'Verify: npm info @wrongstack/core',
      'Test install: npm install -g wrongstack && wrongstack version',
      'GitHub Release created with auto-generated notes',
    ],
  },
];

export const releaseWorkflow = {
  trigger: 'Push a tag matching v*',
  automation: [
    'Typecheck + build + test on 3 platforms',
    'Version tag verification (tag must match package.json)',
    'npm publish for all workspace packages',
    'GitHub Release creation with auto-generated notes',
  ],
  requiredSecrets: ['NPM_TOKEN — npm authentication token with publish access'],
  preReleaseNote: 'Tags containing "-" (e.g. v1.0.0-beta.1) are marked as pre-release on GitHub.',
  hotfix: [
    'git checkout vX.Y.Z',
    'git checkout -b hotfix/X.Y.Z+1',
    'node scripts/bump-version.mjs patch',
    'git commit -am "release: X.Y.Z+1"',
    'git tag vX.Y.Z+1',
    'git push --follow-tags',
  ],
} as const;
