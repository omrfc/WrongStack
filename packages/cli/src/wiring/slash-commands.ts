import {
  SlashCommandRegistry,
  type ToolRegistry,
  type SessionStore,
  type SkillLoader,
  type TokenCounter,
  type Renderer,
  type MemoryStore,
  type Context,
  type ModeStore,
  type MetricsSink,
  type HealthRegistry,
  type Provider,
} from '@wrongstack/core';
import type { CompactReport } from '@wrongstack/core';
import { buildBuiltinSlashCommands } from '../slash-commands/index.js';
import type { StatuslineConfig } from '../slash-commands/statusline.js';
import { loadStatuslineConfig, saveStatuslineConfig } from '../slash-commands/statusline.js';
import { MultiAgentHost } from '../multi-agent.js';

export interface SlashCommandsDeps {
  slashRegistry: SlashCommandRegistry;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  skillLoader: SkillLoader | undefined;
  tokenCounter: TokenCounter;
  renderer: Renderer;
  memoryStore: MemoryStore;
  context: Context;
  cwd: string;
  projectRoot: string;
  metricsSink: MetricsSink | undefined;
  healthRegistry: HealthRegistry | undefined;
  planPath: string;
  modeStore: ModeStore;
  provider: Provider;
  model: string;
  multiAgentHost: MultiAgentHost;
  fleetStreamController: { enabled: boolean; setEnabled(enabled: boolean): void };
  compactor: { compact(ctx: Context, opts?: { aggressive?: boolean }): Promise<CompactReport> };
}

export interface StatuslineConfigDeps {
  get(): Promise<StatuslineConfig>;
  set(cfg: StatuslineConfig): Promise<void>;
}

export async function setupSlashCommands(params: SlashCommandsDeps): Promise<void> {
  const { slashRegistry, toolRegistry, sessionStore, skillLoader, tokenCounter, renderer,
    memoryStore, context, cwd, projectRoot, metricsSink, healthRegistry,
    planPath, modeStore, provider, model, multiAgentHost, fleetStreamController,
    compactor } = params;

  const statuslineConfigDeps: StatuslineConfigDeps = {
    get: () => loadStatuslineConfig(),
    set: (cfg) => saveStatuslineConfig(cfg),
  };

  // Statusline hidden items — derived from the config file
  const hiddenItemsFromConfig = await loadStatuslineConfig();
  const hiddenItemsList: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'> = [];
  const ALL_ITEMS = ['todos', 'plan', 'fleet', 'git', 'elapsed', 'context', 'cost'] as const;
  for (const k of ALL_ITEMS) {
    if (!hiddenItemsFromConfig[k]) hiddenItemsList.push(k);
  }
  const statuslineHiddenItems = hiddenItemsList;
  let currentHiddenItems = [...statuslineHiddenItems];
  const setStatuslineHiddenItems = (items: typeof statuslineHiddenItems) => {
    currentHiddenItems = items;
  };

  const commands = buildBuiltinSlashCommands({
    registry: slashRegistry,
    toolRegistry,
    compactor,
    sessionStore,
    skillLoader,
    tokenCounter,
    renderer,
    memoryStore,
    context,
    cwd,
    projectRoot,
    metricsSink,
    healthRegistry,
    planPath,
    modeStore,
    fleetStreamController,
    llmProvider: provider,
    llmModel: model,
    statuslineConfig: statuslineConfigDeps,
    statuslineHiddenItems: [...currentHiddenItems],
    setStatuslineHiddenItems,
    onSpawn: async (description, spawnOpts) => {
      const { subagentId, taskId } = await multiAgentHost.spawn(description, spawnOpts);
      const tags: string[] = [];
      if (spawnOpts?.provider) tags.push(spawnOpts.provider);
      if (spawnOpts?.model) tags.push(spawnOpts.model);
      if (spawnOpts?.name) tags.push(`"${spawnOpts.name}"`);
      const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
      return `Spawned subagent ${subagentId}${tag} for task ${taskId}. Use /agents to track progress.`;
    },
    onAgents: () => {
      const s = multiAgentHost.status();
      const lines: string[] = [];
      for (const a of s.live) {
        if (a.status === 'running' || a.status === 'idle') {
          lines.push(`• ${a.subagentId.slice(0, 8)}: ${a.status}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') : 'No active subagents.';
    },
  });

  for (const cmd of commands) {
    slashRegistry.register(cmd);
  }
}