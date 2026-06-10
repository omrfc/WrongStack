import type {
  SlashCommandRegistry,
  ToolRegistry,
  SessionStore,
  SkillLoader,
  TokenCounter,
  Renderer,
  MemoryStore,
  Context,
  ModeStore,
  MetricsSink,
  HealthRegistry,
  Provider,
  WstackPaths,
  EventBus,
  ConfigStore,
  InputReader,
} from '@wrongstack/core';
import type { CompactReport } from '@wrongstack/core';
import { buildBuiltinSlashCommands } from '../slash-commands/index.js';
import type { StatuslineConfig } from '../slash-commands/statusline.js';
import { loadStatuslineConfig, saveStatuslineConfig } from '../slash-commands/statusline.js';
import type { MultiAgentHost } from '../multi-agent.js';

export interface SlashCommandsDeps {
  slashRegistry: SlashCommandRegistry;
  toolRegistry: ToolRegistry;
  paths: WstackPaths;
  sessionStore: SessionStore;
  skillLoader: SkillLoader | undefined;
  tokenCounter: TokenCounter;
  renderer: Renderer;
  reader: InputReader;
  events: EventBus;
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
  /** Controller for the agents monitor overlay (optional). */
  agentsMonitorController?: {
    visible: boolean;
    setVisible: (visible: boolean) => void;
  };
  compactor: { compact(ctx: Context, opts?: { aggressive?: boolean | undefined }): Promise<CompactReport> };
  configStore: ConfigStore;
}

export interface StatuslineConfigDeps {
  get(): Promise<StatuslineConfig>;
  set(cfg: StatuslineConfig): Promise<void>;
}

export async function setupSlashCommands(params: SlashCommandsDeps): Promise<void> {
  const { slashRegistry, toolRegistry, paths, sessionStore, skillLoader, tokenCounter, renderer,
    reader, events, memoryStore, context, cwd, projectRoot, metricsSink, healthRegistry,
    planPath, modeStore, provider, model, multiAgentHost, fleetStreamController,
    agentsMonitorController, compactor, configStore } = params;

  const statuslineConfigDeps: StatuslineConfigDeps = {
    get: () => loadStatuslineConfig(),
    set: (cfg) => saveStatuslineConfig(cfg),
  };

  // Statusline hidden items — derived from the config file
  const hiddenItemsFromConfig = await loadStatuslineConfig();
  const hiddenItemsList: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'> = [];
  const ALL_ITEMS = ['todos', 'plan', 'fleet', 'git', 'elapsed', 'context', 'cost', 'working_dir'] as const;
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
    paths,
    compactor,
    sessionStore,
    skillLoader,
    tokenCounter,
    renderer,
    events,
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
    agentsMonitorController,
    onSpawn: async (description, spawnOpts) => {
      const { subagentId, taskId } = await multiAgentHost.spawn(description, spawnOpts);
      const tags: string[] = [];
      if (spawnOpts?.provider) tags.push(spawnOpts.provider);
      if (spawnOpts?.model) tags.push(spawnOpts.model);
      if (spawnOpts?.name) tags.push(`"${spawnOpts.name}"`);
      const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
      return `Spawned subagent ${subagentId}${tag} for task ${taskId}. Use /agents to track progress.`;
    },
    onSpawnAndWait: async (description, spawnOpts) => {
      const result = await multiAgentHost.spawnAndWait(description, spawnOpts);
      const tags: string[] = [];
      if (spawnOpts?.provider) tags.push(spawnOpts.provider);
      if (spawnOpts?.model) tags.push(spawnOpts.model);
      if (spawnOpts?.name) tags.push(spawnOpts.name);
      const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';

      const secs = (result.durationMs / 1000).toFixed(result.durationMs < 10_000 ? 1 : 0);
      const icon =
        result.status === 'success' ? '✓' : result.status === 'timeout' ? '⏱' : result.status === 'stopped' ? '⊘' : '✗';
      const resultPreview =
        typeof result.result === 'string' && result.result.trim()
          ? `\n${result.result.trim().slice(0, 600)}${result.result.trim().length > 600 ? '\n…' : ''}`
          : '';

      return [
        `${icon} ${tag ? tag.slice(1) : 'subagent'} ${result.status} (${result.iterations} iter / ${result.toolCalls} tools / ${secs}s)`,
        resultPreview,
        result.error ? `  error: ${result.error.message}` : '',
      ]
        .filter(Boolean)
        .join('\n');
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
    configStore,
    reader,
  });

  for (const cmd of commands) {
    slashRegistry.register(cmd);
  }
}