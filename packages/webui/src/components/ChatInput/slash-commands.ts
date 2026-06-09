import { expectDefined } from '@wrongstack/core';
// Slash command registry and matching utilities for ChatInput

export type SlashCategory = 'Run' | 'Session' | 'Inspect' | 'Agent' | 'Config' | 'App';

export interface SlashCommandDef {
  name: string;
  aliases?: string[] | undefined;
  description: string;
  category: SlashCategory;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  // Run
  { name: '/abort', category: 'Run', aliases: ['/stop'], description: 'Abort the current run' },
  { name: '/dev', category: 'Run', description: 'Run a shell command and see the output (LLM does not see it)' },
  { name: '/commit', category: 'Run', aliases: ['/gc'], description: 'Generate a conventional commit message (LLM-powered)' },
  { name: '/gitcheck', category: 'Run', aliases: ['/gcstatus'], description: 'Pre-commit sanity check (branch, diff, lint)' },
  { name: '/push', category: 'Run', description: 'Push the current branch to remote' },

  // Session
  { name: '/new', category: 'Session', description: 'Start a brand-new session (fresh on disk and in memory)' },
  { name: '/clear', category: 'Session', description: 'Wipe current context (keeps session id, disk record stays)' },
  { name: '/compact', category: 'Session', description: 'Shrink context — elide ancient tool output' },
  { name: '/repair', category: 'Session', description: 'Repair orphan tool_use/tool_result blocks in context' },
  { name: '/save', category: 'Session', description: 'Force-flush the session (auto-saved already)' },
  { name: '/load', category: 'Session', aliases: ['/resume'], description: 'Resume a previous session from disk' },
  { name: '/prune', category: 'Session', description: 'Delete old sessions (default older than 30 days)' },
  { name: '/export', category: 'Session', description: 'Download the current chat as markdown' },

  // Inspect
  { name: '/debug', category: 'Inspect', aliases: ['/context'], description: 'Per-section context size breakdown' },
  { name: '/tools', category: 'Inspect', description: 'List every registered tool the model can call' },
  { name: '/memory', category: 'Inspect', description: 'Manage memory: show, remember, forget, clear, compact, stats' },
  { name: '/skill', category: 'Inspect', aliases: ['/skills'], description: 'List active skills' },
  { name: '/diag', category: 'Inspect', description: 'Runtime diagnostics (provider, tools, features, mode, usage)' },
  { name: '/stats', category: 'Inspect', description: 'Session stats: tokens, cache hit ratio, cost, elapsed' },
  { name: '/todos', category: 'Inspect', description: 'List current todos (try `/todos clear` to reset)' },
  { name: '/codebase-reindex', category: 'Inspect', aliases: ['/reindex'], description: 'Rebuild the codebase symbol index' },
  { name: '/security', category: 'Inspect', description: 'Security scanning: /security scan | audit | report' },
  { name: '/metrics', category: 'Inspect', description: 'Show runtime metrics snapshot (requires --metrics)' },
  { name: '/health', category: 'Inspect', description: 'Show health check status' },

  // Agent
  { name: '/spawn', category: 'Agent', description: 'Spawn an isolated subagent to handle a task' },
  { name: '/agents', category: 'Agent', description: 'Show status of spawned subagents' },
  { name: '/fleet', category: 'Agent', description: 'Inspect and control the agent fleet' },
  { name: '/director', category: 'Agent', description: 'Promote to director mode at runtime' },
  { name: '/autonomy', category: 'Agent', description: 'Toggle or query autonomy mode (self-driving agent)' },
  { name: '/goal', category: 'Agent', description: 'Set, inspect, or clear the autonomous mission' },
  { name: '/autophase', category: 'Agent', description: 'Autonomous phase-based workflow with subagents' },
  { name: '/fix', category: 'Agent', description: 'Diagnose and fix a reported error or bug' },
  { name: '/sdd', category: 'Agent', description: 'AI-driven Specification-Driven Development workflow' },
  { name: '/btw', category: 'Agent', description: 'Drop a mid-run note without interrupting the agent' },
  { name: '/collab', category: 'Agent', description: 'Live collaboration helpers (status / invite / history)' },
  { name: '/prompts', category: 'Agent', description: 'Manage prompt library: list, view, add, delete, edit, extend' },
  { name: '/plan', category: 'Agent', description: 'Strategic plan board: show, add, start, done, promote, clear' },
  { name: '/skill-gen', category: 'Agent', description: 'Generate a new skill from a description (LLM-powered)' },
  { name: '/skill-install', category: 'Agent', description: 'Install a skill from GitHub (user/repo or URL)' },
  { name: '/skill-update', category: 'Agent', description: 'Update an installed skill to the latest version' },
  { name: '/skill-uninstall', category: 'Agent', description: 'Remove an installed skill' },

  // Config
  { name: '/settings', category: 'Config', aliases: ['/model'], description: 'Open settings (provider/model/keys)' },
  { name: '/setmodel', category: 'Config', description: 'Quick-switch the active provider/model' },
  { name: '/models', category: 'Config', description: 'List available providers and models' },
  { name: '/mode', category: 'Config', description: 'Switch the active mode (persona/skill set)' },
  { name: '/yolo', category: 'Config', description: 'Toggle or query YOLO (auto-approve) mode' },
  { name: '/next', category: 'Config', description: 'Toggle next-task prediction after each turn' },
  { name: '/enhance', category: 'Config', description: 'Toggle prompt refinement before sending' },
  { name: '/mcp', category: 'Config', aliases: ['/mcp-servers'], description: 'Manage MCP servers' },
  { name: '/plugin', category: 'Config', aliases: ['/plugins'], description: 'Manage plugins' },
  { name: '/statusline', category: 'Config', aliases: ['/sl'], description: 'Customize status bar chips' },
  { name: '/telegram-setup', category: 'Config', aliases: ['/tg-setup'], description: 'Configure Telegram bot token and chat' },
  { name: '/init', category: 'Config', description: 'Create or update .wrongstack/AGENTS.md project context' },
  { name: '/worktree', category: 'Config', aliases: ['/wt'], description: 'Inspect/manage git worktrees for AutoPhase' },
  { name: '/sync', category: 'Config', description: 'GitHub cloud sync for settings, skills, prompts, memory' },

  // App
  { name: '/help', category: 'App', description: 'Show every slash command and what it does' },
  { name: '/exit', category: 'App', description: 'Exit the current session' },
];

export const SLASH_CATEGORY_ORDER: SlashCategory[] = ['Run', 'Session', 'Inspect', 'Agent', 'Config', 'App'];

export function matchSlash(query: string): SlashCommandDef[] {
  const q = query.toLowerCase();
  if (q === '/' || q === '') return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (c) => c.name.startsWith(q) || (c.aliases?.some((a) => a.startsWith(q)) ?? false),
  );
}

export function detectAtMention(value: string, cursor: number): { start: number; query: string } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const c = expectDefined(value[i]);
    if (c === '@') {
      const prev = i > 0 ? value[i - 1] : '';
      if (i === 0 || /\s/.test(prev ?? '')) {
        return { start: i, query: value.slice(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(c)) return null;
    i--;
  }
  return null;
}
