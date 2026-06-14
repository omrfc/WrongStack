import type { TextBlock } from '@wrongstack/core';
import {
  type Config,
  createContextManagerTool,
  type DefaultMemoryStore,
  type DefaultModelsRegistry,
  DefaultModeStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  makeMailboxTool,
  makeMailInboxTool,
  makeMailSendTool,
  TOKENS,
  type ToolRegistry,
  type WstackPaths,
} from '@wrongstack/core';
import {
  builtinToolsPack,
  forgetTool,
  relatedMemoryTool,
  rememberTool,
  searchMemoryTool,
  TIER1_TOOLS,
} from '@wrongstack/tools';
import { resolveBundledSkillsDir } from '../cli-bundled-skills.js';

export interface ToolsWiringDeps {
  config: Config;
  toolRegistry: ToolRegistry;
  modelsRegistry: DefaultModelsRegistry;
  memoryStore: DefaultMemoryStore;
  wpaths: WstackPaths;
  projectRoot: string;
  cwd: string;
  container: { resolve<T>(tok: unknown): T; has(tok: unknown): boolean };
}

export interface ToolsWiringResult {
  toolRegistry: ToolRegistry;
  systemPrompt: Promise<TextBlock[]>;
  promptBuilder: DefaultSystemPromptBuilder;
  modeStore: DefaultModeStore;
  skillLoader: DefaultSkillLoader | undefined;
  memoryStore: DefaultMemoryStore;
}

export async function setupTools(params: ToolsWiringDeps): Promise<ToolsWiringResult> {
  const { config, toolRegistry, modelsRegistry, memoryStore, wpaths, container, projectRoot, cwd } =
    params;

  // Tool registry — already created by caller, just configure it here.
  // Token-saving mode (Tier 1): register only the 10 minimal tools.
  // Full mode (Tier 2): register all tools.
  const allTools = builtinToolsPack.tools ?? [];
  const toolsToRegister = config.features.tokenSavingMode ? TIER1_TOOLS : allTools;
  toolRegistry.registerAllOrThrow([...toolsToRegister], builtinToolsPack.name);
  toolRegistry.registerDefault(
    createContextManagerTool({ compactor: container.resolve(TOKENS.Compactor) }),
  );
  // Register the inter-agent mailbox tools — resolve to the project-level
  // GlobalMailbox at runtime. mail_send/mail_inbox are the high-affordance
  // thin wrappers agents reach for autonomously.
  toolRegistry.register(makeMailboxTool({ projectDir: wpaths.projectDir }));
  toolRegistry.register(makeMailSendTool({ projectDir: wpaths.projectDir }));
  toolRegistry.register(makeMailInboxTool({ projectDir: wpaths.projectDir }));
  if (config.features.memory) {
    toolRegistry.register(rememberTool(memoryStore));
    toolRegistry.register(forgetTool(memoryStore));
    toolRegistry.register(searchMemoryTool(memoryStore));
    toolRegistry.register(relatedMemoryTool(memoryStore));
  }

  // Mode store
  const modeStore = new DefaultModeStore({ directory: wpaths.configDir });
  const activeMode = await modeStore.getActiveMode();
  const modeId = activeMode?.id ?? 'default';
  const modePrompt = activeMode?.prompt ?? '';

  // Skill loader — discovers project, user, and bundled skills.
  // Bundled skills ship with @wrongstack/core (packages/core/skills/).
  const skillLoader = config.features.skills
    ? new DefaultSkillLoader({
        paths: wpaths,
        bundledDir: resolveBundledSkillsDir(),
      })
    : undefined;

  // Resolve model capabilities for system prompt
  const resolvedModel = await modelsRegistry.getModel(config.provider, config.model);
  const modelCapabilities = resolvedModel?.capabilities
    ? {
        maxContextTokens: resolvedModel.capabilities.maxContext,
        supportsTools: resolvedModel.capabilities.tools,
        supportsVision: resolvedModel.capabilities.vision,
        supportsReasoning: resolvedModel.capabilities.reasoning,
      }
    : undefined;

  // System prompt builder
  const promptBuilder = new DefaultSystemPromptBuilder({
    memoryStore,
    skillLoader,
    modeStore,
    modeId,
    modePrompt,
    modelCapabilities,
    tokenSavingMode: config.features.tokenSavingMode,
  });

  const systemPrompt = promptBuilder.build({
    cwd,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
  });

  return { toolRegistry, systemPrompt, promptBuilder, modeStore, skillLoader, memoryStore };
}
