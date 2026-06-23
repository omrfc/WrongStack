import type {
  CompactReport,
  ConfigStore,
  Context,
  EventBus,
  HealthRegistry,
  InputReader,
  MemoryStore,
  MetricsSink,
  ModeStore,
  Provider,
  Renderer,
  SessionStore,
  SkillLoader,
  SlashCommandRegistry,
  TokenCounter,
  ToolRegistry,
  WstackPaths,
} from '@wrongstack/core';
import type { MultiAgentHost } from '../multi-agent.js';
import { buildBuiltinSlashCommands } from '../slash-commands/index.js';
import type { StatuslineConfig } from '../slash-commands/statusline.js';
import { loadStatuslineConfig, saveStatuslineConfig } from '../slash-commands/statusline.js';

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
  /** Agent Monitor Service — subagent conversation tracking and HQ streaming. */
  agentMonitor?: import('@wrongstack/core/coordination').AgentMonitorService | undefined;
  compactor: {
    compact(ctx: Context, opts?: { aggressive?: boolean | undefined }): Promise<CompactReport>;
  };
  configStore: ConfigStore;
  /** Called by /clear after wiping the session on disk — tells the TUI to reset its UI state. */
  onNewSession?: (() => Promise<void>) | undefined;
  /**
   * Mutable ref for opening a TUI panel by dispatching its action type.
   * The slash commands call `onPanelOpen.current(action)` to open panels.
   * The TUI sets `onPanelOpen.current` to its actual dispatch function on mount.
   */
  onPanelOpen: { current: ((action: string) => boolean) | null };
}

export interface StatuslineConfigDeps {
  get(): Promise<StatuslineConfig>;
  set(cfg: StatuslineConfig): Promise<void>;
}

export async function setupSlashCommands(params: SlashCommandsDeps): Promise<void> {
  const {
    slashRegistry,
    toolRegistry,
    paths,
    sessionStore,
    skillLoader,
    tokenCounter,
    renderer,
    reader,
    events,
    memoryStore,
    context,
    cwd,
    projectRoot,
    metricsSink,
    healthRegistry,
    planPath,
    modeStore,
    provider,
    model,
    multiAgentHost,
    fleetStreamController,
    agentsMonitorController,
    compactor,
    configStore,
    onNewSession,
    onPanelOpen,
  } = params;

  const statuslineConfigDeps: StatuslineConfigDeps = {
    get: () => loadStatuslineConfig(),
    set: (cfg) => saveStatuslineConfig(cfg),
  };

  // Statusline hidden items — derived from the config file
  const hiddenItemsFromConfig = await loadStatuslineConfig();
  const hiddenItemsList: Array<
    'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
  > = [];
  const ALL_ITEMS = ['todos', 'plan', 'tasks', 'fleet', 'git', 'elapsed', 'context', 'cost', 'working_dir'] as const;
  for (const k of ALL_ITEMS) {
    if (!hiddenItemsFromConfig[k]) hiddenItemsList.push(k);
  }
  const statuslineHiddenItems = hiddenItemsList;
  let currentHiddenItems = [...statuslineHiddenItems] as Array<
    'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
  >;
  const setStatuslineHiddenItems = (
    items: Array<
      'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
    >,
  ) => {
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
    agentMonitor: params.agentMonitor,
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
        result.status === 'success'
          ? '✓'
          : result.status === 'timeout'
            ? '⏱'
            : result.status === 'stopped'
              ? '⊘'
              : '✗';
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
    onNewSession,
    onPanelOpen,
  });

  for (const cmd of commands) {
    slashRegistry.register(cmd);
  }
}
