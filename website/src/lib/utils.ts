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
  version: '0.54.1',
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
  '/init',
  '/help',
  '/clear',
  '/compact',
  '/context',
  '/diag',
  '/stats',
  '/usage',
  '/tools',
  '/skill',
  '/use',
  '/model',
  '/save',
  '/resume',
  '/plan',
  '/mode',
  '/yolo',
  '/autonomy',
  '/goal',
  '/spawn',
  '/fleet',
  '/agents',
  '/director',
  '/steer',
  '/queue',
  '/autophase',
  '/worktree',
  '/sdd',
  '/mcp',
  '/plugin',
  '/telegram',
  '/memory',
  '/metrics',
  '/health',
  '/commit',
  '/security',
  '/fix',
  '/image',
  '/altscreen',
  '/statusline',
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
