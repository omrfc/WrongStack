import type {
  CompactReport,
  Context,
  HealthRegistry,
  MemoryStore,
  MetricsSink,
  ModeStore,
  Renderer,
  SessionStore,
  SkillLoader,
  SlashCommand,
  SlashCommandRegistry,
  TokenCounter,
  ToolRegistry,
} from '@wrongstack/core';

export interface SlashCommandContext {
  registry: SlashCommandRegistry;
  toolRegistry: ToolRegistry;
  compactor?: {
    compact(ctx: Context, opts?: { aggressive?: boolean }): Promise<CompactReport>;
  };
  sessionStore?: SessionStore;
  skillLoader?: SkillLoader;
  tokenCounter: TokenCounter;
  renderer: Renderer;
  memoryStore?: MemoryStore;
  context?: Context;
  /** Working directory for the current session. */
  cwd: string;
  /** Project root (typically resolved from cwd). */
  projectRoot: string;
  metricsSink?: MetricsSink;
  healthRegistry?: HealthRegistry;
  modeStore?: ModeStore;
  onExit?: () => void;
  onBeforeExit?: () => Promise<{ abort?: boolean; message?: string } | void>;
  onClear?: () => void;
  onDiag?: () => string;
  onStats?: () => string | null;
  /**
   * Generate a commit message by calling the LLM with the git diff.
   * Receives the raw diff, returns a commit message string.
   * When omitted /commit falls back to heuristics-only messages.
   */
  generateCommitMessage?: (diff: string) => Promise<string>;
  onSpawn?: (
    description: string,
    opts?: { provider?: string; model?: string; tools?: string[]; name?: string },
  ) => Promise<string>;
  onAgents?: () => string;
  onFleet?: (action: 'status' | 'usage' | 'kill' | 'manifest', target?: string) => Promise<string>;
  /**
   * Toggle subagent activity streaming into the leader's history. The
   * TUI installs the actual setter on mount via a shared controller;
   * before that, calls are buffered into the initial-value field so
   * `/fleet stream off` issued before mount still takes effect.
   */
  fleetStreamController?: {
    /** Current state, readable for the slash command's reply. */
    enabled: boolean;
    /** Replaced by the TUI on mount with a dispatch-backed setter. */
    setEnabled: (enabled: boolean) => void;
  };
  /**
   * Re-run interrupted tasks from a prior director-state.json. Pass `undefined`
   * to list them, a specific task id to retry one, or 'all' to retry every
   * interrupted task. Returns a human-readable summary. Only wired when
   * director mode is enabled.
   */
  onFleetRetry?: (taskId?: string) => Promise<string>;
  /**
   * Inspect per-subagent JSONL transcripts under `<fleetRoot>/subagents/`.
   * Pass `undefined` to list available transcripts, a subagent id to show
   * a compact event summary, or a subagent id with `mode='raw'` to dump
   * the full JSONL. Only wired when a fleet root exists for this session.
   */
  onFleetLog?: (subagentId: string | undefined, mode: 'summary' | 'raw') => Promise<string>;
  /** Promote to director mode at runtime. Returns success message or null on failure. */
  onDirector?: () => Promise<string | null>;
  /** Manage plugin config from the interactive slash menu. */
  onPlugin?: (args: string) => Promise<string>;
  /** Toggle or query YOLO mode at runtime. Pass undefined to query, boolean to set. */
  onYolo?: (setTo?: boolean) => boolean;
  /** Toggle or query autonomy mode. Pass undefined to query, AutonomyMode to set. */
  onAutonomy?: (setTo?: import('./autonomy.js').AutonomyMode) => import('./autonomy.js').AutonomyMode;
  /**
   * Absolute path to the per-session plan JSON file. Read+written by the
   * `/plan` slash command. Optional — when omitted, `/plan` short-circuits
   * with a "not configured" message instead of crashing.
   */
  planPath?: string;
  /** Direct access to the session's LLM provider and model, available even before the first agent run. */
  llmProvider?: import('@wrongstack/core').Provider;
  llmModel?: string;
  /** StatusBar visibility config — loaded from ~/.wrongstack/statusline.json */
  statuslineConfig?: {
    get: () => Promise<import('./statusline.js').StatuslineConfig>;
    set: (cfg: import('./statusline.js').StatuslineConfig) => Promise<void>;
  };
  /**
   * Current list of hidden status bar items. Written by the /statusline command
   * so the TUI can update without a restart.
   */
  statuslineHiddenItems?: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>;
  setStatuslineHiddenItems?: (items: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>) => void;
}

// Re-export helpers for external consumers (pre-launch.ts)
export type { ProjectFacts } from './helpers.js';
export { detectProjectFacts, renderAgentsTemplate } from './helpers.js';

import { buildClearCommand } from './clear.js';
import {
  buildCommitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from './commit.js';
import { buildCompactCommand } from './compact.js';
import { buildContextCommand } from './context.js';
import { buildDiagCommand, buildStatsCommand } from './diag-stats.js';
import { buildFleetCommand } from './fleet.js';
import { buildHealthCommand } from './health.js';
import { buildHelpCommand } from './help.js';
import { buildInitCommand } from './init.js';
import { buildMemoryCommand } from './memory.js';
import { buildMetricsCommand } from './metrics.js';
import { buildPlanCommand } from './plan.js';
import { buildPluginCommand } from './plugin.js';
import { buildExitCommand, buildLoadCommand, buildSaveCommand } from './session.js';
import { buildSkillCommand } from './skill.js';
import { buildAgentsCommand, buildDirectorCommand, buildSpawnCommand } from './spawn-agents.js';
import { buildTodosCommand } from './todos.js';
import { buildToolsCommand } from './tools.js';
import { buildYoloCommand } from './yolo.js';
import { buildAutonomyCommand } from './autonomy.js';
import { buildModeCommand } from './mode.js';
import { buildSddCommand } from './sdd.js';
import { buildSkillGeneratorCommand } from './skill-generator.js';
import { buildSecurityCommand } from './security.js';
import { buildStatuslineCommand } from './statusline.js';
import {
  buildSkillInstallCommand,
  buildSkillUpdateCommand,
  buildSkillUninstallCommand,
} from './skill-install.js';

export function buildBuiltinSlashCommands(opts: SlashCommandContext): SlashCommand[] {
  return [
    buildHelpCommand(opts),
    buildInitCommand(opts),
    buildClearCommand(opts),
    buildCompactCommand(opts),
    buildContextCommand(opts),
    buildToolsCommand(opts),
    buildSkillCommand(opts),
    buildSkillGeneratorCommand(opts),
    buildSkillInstallCommand(opts),
    buildSkillUpdateCommand(opts),
    buildSkillUninstallCommand(opts),
    buildPluginCommand(opts),
    buildDiagCommand(opts),
    buildStatsCommand(opts),
    buildSpawnCommand(opts),
    buildAgentsCommand(opts),
    buildDirectorCommand(opts),
    buildFleetCommand(opts),
    buildMetricsCommand(opts),
    buildHealthCommand(opts),
    buildMemoryCommand(opts),
    buildTodosCommand(opts),
    buildPlanCommand(opts),
    buildSddCommand(opts),
    buildSaveCommand(opts),
    buildLoadCommand(opts),
    buildYoloCommand(opts),
    buildAutonomyCommand(opts),
    buildModeCommand(opts),
    buildExitCommand(opts),
    buildCommitCommand(opts),
    buildGitcheckCommand(opts),
    buildPushCommand(opts),
    buildSecurityCommand(opts),
    buildStatuslineCommand({
      cwd: opts.cwd,
      hiddenItems: opts.statuslineHiddenItems ?? [],
      setHiddenItems: opts.setStatuslineHiddenItems ?? (() => {}),
      getConfig: opts.statuslineConfig?.get ?? (async () => ({})),
      setConfig: opts.statuslineConfig?.set ?? (async () => {}),
    }),
  ];
}
