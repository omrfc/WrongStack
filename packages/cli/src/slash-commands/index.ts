import type {
  CompactReport,
  Context,
  HealthRegistry,
  MemoryStore,
  MetricsSink,
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
  metricsSink?: MetricsSink;
  healthRegistry?: HealthRegistry;
  onExit?: () => void;
  onClear?: () => void;
  onDiag?: () => string;
  onStats?: () => string | null;
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
  /**
   * Absolute path to the per-session plan JSON file. Read+written by the
   * `/plan` slash command. Optional — when omitted, `/plan` short-circuits
   * with a "not configured" message instead of crashing.
   */
  planPath?: string;
}

// Re-export helpers for external consumers (pre-launch.ts)
export type { ProjectFacts } from './helpers.js';
export { detectProjectFacts, renderAgentsTemplate } from './helpers.js';

import { buildClearCommand } from './clear.js';
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

export function buildBuiltinSlashCommands(opts: SlashCommandContext): SlashCommand[] {
  return [
    buildHelpCommand(opts),
    buildInitCommand(opts),
    buildClearCommand(opts),
    buildCompactCommand(opts),
    buildContextCommand(opts),
    buildToolsCommand(opts),
    buildSkillCommand(opts),
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
    buildSaveCommand(opts),
    buildLoadCommand(opts),
    buildExitCommand(opts),
  ];
}
