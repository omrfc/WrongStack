import type {
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
    compact(
      ctx: Context,
      opts?: { aggressive?: boolean },
    ): Promise<{
      before: number;
      after: number;
      reductions: Array<{ phase: string; saved: number }>;
    }>;
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
  /** Promote to director mode at runtime. Returns success message or null on failure. */
  onDirector?: () => Promise<string | null>;
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
import { buildExitCommand, buildLoadCommand, buildSaveCommand } from './session.js';
import { buildSkillCommand } from './skill.js';
import { buildAgentsCommand, buildSpawnCommand, buildDirectorCommand } from './spawn-agents.js';
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
    buildSaveCommand(opts),
    buildLoadCommand(opts),
    buildExitCommand(opts),
  ];
}
